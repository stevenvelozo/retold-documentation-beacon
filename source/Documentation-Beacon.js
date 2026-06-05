'use strict';

/**
 * Documentation Beacon - bidirectional sync between a documentation folder tree
 * and a Retold Docs Lake, over /1.0/docs/*.
 *
 * The reconcile loop snapshots three trees - ours (the folder), theirs (the
 * platform head), and base (the last common version we recorded locally) - and
 * for each path takes the side that changed. When both sides changed the same
 * path it runs a git 3-way merge (clean -> auto-merge, conflict -> standard
 * markers). The result is written to the folder and pushed to the platform, and
 * the base advances so steady state is ours == theirs == base.
 *
 * The base lives in a local .docsync/ folder inside the working copy: state.json
 * (the platform commit we are based on) plus a content mirror of the base tree
 * (so the 3-way merge has real base files). chokidar drives reconciles on file
 * changes; a periodic tick is the safety net behind the watch.
 *
 *   let beacon = new DocumentationBeacon({ ServerURL, Folder, UserName, Password });
 *   await beacon.start();          // authenticate, reconcile once, then watch
 *   await beacon.reconcileOnce();  // one pass (used by tests / Ultravisor)
 */

const libFS = require('fs');
const libPath = require('path');
const libOS = require('os');
const libCrypto = require('crypto');
const libChildProcess = require('child_process');

const libPlatformClient = require('./Platform-Client.js');

const _STATE_DIR = '.docsync';
const _SKIP = { '.git': 1, '.docsync': 1, 'node_modules': 1, 'app': 1 };
const _TEXT_EXT = { '.md': 1, '.markdown': 1, '.txt': 1, '.json': 1, '.svg': 1, '.csv': 1, '.yml': 1, '.yaml': 1 };

class DocumentationBeacon
{
	constructor(pOptions)
	{
		let tmpOptions = pOptions || {};
		this.folder = libPath.resolve(tmpOptions.Folder || process.cwd());
		this.stateDir = libPath.join(this.folder, _STATE_DIR);
		this.baseDir = libPath.join(this.stateDir, 'base');
		this.log = tmpOptions.Log || console;
		this.pollMs = (typeof tmpOptions.PollMs === 'number') ? tmpOptions.PollMs : 30000;
		this.debounceMs = (typeof tmpOptions.DebounceMs === 'number') ? tmpOptions.DebounceMs : 800;
		this.client = tmpOptions.Client || new libPlatformClient(
			{ ServerURL: tmpOptions.ServerURL, UserName: tmpOptions.UserName, Password: tmpOptions.Password, Log: this.log });
		this._running = false;
		this._reconciling = false;
		this._pending = false;
		this._watcher = null;
		this._timer = null;
		this.lastSummary = null;
		this.lastReconcileAt = null;
	}

	// ─── small helpers ───────────────────────────────────────────────────
	_sha256(pBuffer) { return libCrypto.createHash('sha256').update(pBuffer).digest('hex'); }
	_isText(pPath) { return !!_TEXT_EXT[libPath.extname(pPath).toLowerCase()]; }

	_walk(pDir, pRel, pOut)
	{
		let tmpEntries = libFS.readdirSync(pDir, { withFileTypes: true });
		for (let i = 0; i < tmpEntries.length; i++)
		{
			let tmpName = tmpEntries[i].name;
			if (tmpName.charAt(0) === '.' || _SKIP[tmpName]) { continue; }
			let tmpFull = libPath.join(pDir, tmpName);
			let tmpRel = pRel ? (pRel + '/' + tmpName) : tmpName;
			if (tmpEntries[i].isDirectory()) { this._walk(tmpFull, tmpRel, pOut); }
			else if (tmpEntries[i].isFile()) { pOut[tmpRel] = tmpFull; }
		}
		return pOut;
	}

	// Snapshot the folder: path -> { Hash, Buffer }.
	_snapshotFolder()
	{
		let tmpFiles = this._walk(this.folder, '', {});
		let tmpTree = {};
		Object.keys(tmpFiles).forEach((pPath) =>
		{
			let tmpBuf = libFS.readFileSync(tmpFiles[pPath]);
			tmpTree[pPath] = { Hash: this._sha256(tmpBuf), Buffer: tmpBuf };
		});
		return tmpTree;
	}

	// ─── the local base (last common version) ────────────────────────────
	_loadBase()
	{
		let tmpStatePath = libPath.join(this.stateDir, 'state.json');
		let tmpState = { PlatformCommit: '', Tree: {} };
		try { if (libFS.existsSync(tmpStatePath)) { tmpState = JSON.parse(libFS.readFileSync(tmpStatePath, 'utf8')); } }
		catch (pErr) { this.log.warn('docsync: could not read base state (' + (pErr.message || pErr) + '); starting empty.'); }
		return tmpState;
	}

	_baseContent(pPath)
	{
		let tmpFile = libPath.join(this.baseDir, pPath);
		try { return libFS.existsSync(tmpFile) ? libFS.readFileSync(tmpFile) : Buffer.alloc(0); }
		catch (pErr) { return Buffer.alloc(0); }
	}

	// Rewrite the base mirror + state to a new common tree (path -> { Hash, Buffer }).
	_saveBase(pPlatformCommit, pTree)
	{
		// Replace the base content mirror.
		try { libFS.rmSync(this.baseDir, { recursive: true, force: true }); } catch (pErr) { /* ignore */ }
		libFS.mkdirSync(this.baseDir, { recursive: true });
		let tmpTreeHashes = {};
		Object.keys(pTree).forEach((pPath) =>
		{
			tmpTreeHashes[pPath] = pTree[pPath].Hash;
			let tmpDest = libPath.join(this.baseDir, pPath);
			libFS.mkdirSync(libPath.dirname(tmpDest), { recursive: true });
			libFS.writeFileSync(tmpDest, pTree[pPath].Buffer);
		});
		libFS.mkdirSync(this.stateDir, { recursive: true });
		libFS.writeFileSync(libPath.join(this.stateDir, 'state.json'),
			JSON.stringify({ PlatformCommit: pPlatformCommit, Tree: tmpTreeHashes, UpdatedAt: new Date().toISOString() }, null, '\t'));
	}

	// ─── git 3-way merge ─────────────────────────────────────────────────
	_merge3(pOurs, pBase, pTheirs)
	{
		let tmpDir = libFS.mkdtempSync(libPath.join(libOS.tmpdir(), 'docsync-merge-'));
		try
		{
			let tmpOursFile = libPath.join(tmpDir, 'ours');
			let tmpBaseFile = libPath.join(tmpDir, 'base');
			let tmpTheirsFile = libPath.join(tmpDir, 'theirs');
			libFS.writeFileSync(tmpOursFile, pOurs);
			libFS.writeFileSync(tmpBaseFile, pBase);
			libFS.writeFileSync(tmpTheirsFile, pTheirs);
			let tmpConflict = false;
			let tmpOut;
			try
			{
				tmpOut = libChildProcess.execFileSync('git',
					['merge-file', '-p', '-L', 'folder (yours)', '-L', 'base', '-L', 'platform (theirs)', tmpOursFile, tmpBaseFile, tmpTheirsFile],
					{ maxBuffer: 64 * 1024 * 1024 });
			}
			catch (pError)
			{
				// git merge-file exits non-zero on conflicts; stdout still holds the
				// merged-with-markers content.
				if (pError.stdout != null) { tmpOut = pError.stdout; tmpConflict = true; }
				else { throw pError; }
			}
			return { Content: Buffer.isBuffer(tmpOut) ? tmpOut : Buffer.from(tmpOut), Conflict: tmpConflict };
		}
		finally
		{
			try { libFS.rmSync(tmpDir, { recursive: true, force: true }); } catch (pErr) { /* ignore */ }
		}
	}

	// ─── the reconcile pass ──────────────────────────────────────────────
	async reconcileOnce()
	{
		let tmpOurs = this._snapshotFolder();
		let tmpManifest = await this.client.getManifest();
		let tmpTheirs = tmpManifest.Tree || {};
		let tmpBase = this._loadBase();
		let tmpBaseTree = tmpBase.Tree || {};

		let tmpPaths = new Set(Object.keys(tmpOurs).concat(Object.keys(tmpTheirs)).concat(Object.keys(tmpBaseTree)));

		let tmpToFolderWrite = {};   // path -> Buffer
		let tmpToFolderDelete = [];  // path
		let tmpPuts = {};            // path -> string/Buffer
		let tmpDeletes = [];         // path
		let tmpConflicts = [];       // path
		let tmpNewBase = {};         // path -> { Hash, Buffer }

		// Lazily fetch a platform blob once, cached for this pass.
		let tmpTheirsCache = {};
		let fTheirsContent = async (pPath) =>
		{
			if (!(pPath in tmpTheirsCache)) { tmpTheirsCache[pPath] = await this.client.getDoc(pPath); }
			return tmpTheirsCache[pPath];
		};
		let fKeepBase = (pPath, pBuffer) => { tmpNewBase[pPath] = { Hash: this._sha256(pBuffer), Buffer: pBuffer }; };

		for (let pPath of tmpPaths)
		{
			let tmpO = tmpOurs[pPath] ? tmpOurs[pPath].Hash : null;
			let tmpT = tmpTheirs[pPath] ? tmpTheirs[pPath].Hash : null;
			let tmpB = tmpBaseTree[pPath] || null;

			if (tmpO && tmpT && tmpO === tmpT)
			{
				// Already identical on both sides.
				fKeepBase(pPath, tmpOurs[pPath].Buffer);
			}
			else if (tmpO === tmpB && tmpT !== tmpB)
			{
				// Ours unchanged since base; platform changed -> pull.
				if (tmpT) { let tmpBuf = await fTheirsContent(pPath); tmpToFolderWrite[pPath] = tmpBuf; fKeepBase(pPath, tmpBuf); }
				else { tmpToFolderDelete.push(pPath); /* platform deleted -> drop from base */ }
			}
			else if (tmpT === tmpB && tmpO !== tmpB)
			{
				// Platform unchanged since base; folder changed -> push.
				if (tmpO) { tmpPuts[pPath] = tmpOurs[pPath].Buffer; fKeepBase(pPath, tmpOurs[pPath].Buffer); }
				else { tmpDeletes.push(pPath); /* folder deleted -> drop from base */ }
			}
			else
			{
				// Both sides diverged from base.
				let tmpOurBuf = tmpO ? tmpOurs[pPath].Buffer : null;
				let tmpTheirBuf = tmpT ? await fTheirsContent(pPath) : null;
				let tmpBaseBuf = this._baseContent(pPath);

				if (tmpOurBuf && tmpTheirBuf)
				{
					if (this._isText(pPath))
					{
						let tmpMerge = this._merge3(tmpOurBuf, tmpBaseBuf, tmpTheirBuf);
						tmpToFolderWrite[pPath] = tmpMerge.Content;
						tmpPuts[pPath] = tmpMerge.Content;
						fKeepBase(pPath, tmpMerge.Content);
						if (tmpMerge.Conflict) { tmpConflicts.push(pPath); }
					}
					else
					{
						// Binary changed on both sides - cannot text-merge. Keep the
						// folder copy, push it, and flag the conflict.
						tmpPuts[pPath] = tmpOurBuf;
						fKeepBase(pPath, tmpOurBuf);
						tmpConflicts.push(pPath);
					}
				}
				else if (tmpOurBuf && !tmpTheirBuf)
				{
					// Folder modified, platform deleted (delete/modify) -> keep ours.
					tmpPuts[pPath] = tmpOurBuf;
					fKeepBase(pPath, tmpOurBuf);
					tmpConflicts.push(pPath);
				}
				else if (!tmpOurBuf && tmpTheirBuf)
				{
					// Platform modified, folder deleted (delete/modify) -> keep theirs.
					tmpToFolderWrite[pPath] = tmpTheirBuf;
					fKeepBase(pPath, tmpTheirBuf);
					tmpConflicts.push(pPath);
				}
				// else both deleted -> gone, no base entry.
			}
		}

		// Apply folder writes / deletes.
		Object.keys(tmpToFolderWrite).forEach((pPath) =>
		{
			let tmpDest = libPath.join(this.folder, pPath);
			libFS.mkdirSync(libPath.dirname(tmpDest), { recursive: true });
			libFS.writeFileSync(tmpDest, tmpToFolderWrite[pPath]);
		});
		tmpToFolderDelete.forEach((pPath) =>
		{
			try { libFS.unlinkSync(libPath.join(this.folder, pPath)); } catch (pErr) { /* already gone */ }
		});

		// Push the platform changeset.
		let tmpPutPaths = Object.keys(tmpPuts);
		let tmpResult = { Commit: tmpManifest.Commit, Changed: false };
		if (tmpPutPaths.length || tmpDeletes.length)
		{
			let tmpPutStrings = {};
			tmpPutPaths.forEach((pPath) => { tmpPutStrings[pPath] = tmpPuts[pPath].toString('utf8'); });
			tmpResult = await this.client.commit(
				{
					Puts: tmpPutStrings, Deletes: tmpDeletes, Conflicts: tmpConflicts,
					Source: 'beacon', Message: 'Sync ' + (tmpPutPaths.length + tmpDeletes.length) + ' change(s) from folder'
				});
		}

		// Advance the base to the new common tree.
		this._saveBase(tmpResult.Commit || tmpManifest.Commit, tmpNewBase);

		let tmpSummary =
		{
			Pulled: Object.keys(tmpToFolderWrite).length + tmpToFolderDelete.length,
			Pushed: tmpPutPaths.length + tmpDeletes.length,
			Conflicts: tmpConflicts.length,
			ConflictPaths: tmpConflicts,
			PlatformCommit: (tmpResult.Commit || tmpManifest.Commit || '').slice(0, 12)
		};
		this.log.info('docsync: reconciled - pulled ' + tmpSummary.Pulled + ', pushed ' + tmpSummary.Pushed
			+ ', conflicts ' + tmpSummary.Conflicts + ' (commit ' + tmpSummary.PlatformCommit + ')');
		this.lastSummary = tmpSummary;
		this.lastReconcileAt = new Date().toISOString();
		return tmpSummary;
	}

	// Debounced reconcile that also coalesces overlapping triggers.
	async _reconcileSafe()
	{
		if (this._reconciling) { this._pending = true; return; }
		this._reconciling = true;
		try { await this.reconcileOnce(); }
		catch (pErr) { this.log.warn('docsync: reconcile failed - ' + (pErr.message || pErr)); }
		finally
		{
			this._reconciling = false;
			if (this._pending) { this._pending = false; this._scheduleReconcile(); }
		}
	}

	_scheduleReconcile()
	{
		if (this._debounceTimer) { clearTimeout(this._debounceTimer); }
		this._debounceTimer = setTimeout(() => { this._debounceTimer = null; this._reconcileSafe(); }, this.debounceMs);
	}

	// ─── lifecycle ───────────────────────────────────────────────────────
	async start()
	{
		await this.client.authenticate();
		this.log.info('docsync: authenticated; watching ' + this.folder);
		await this._reconcileSafe();

		let libChokidar = require('chokidar');
		this._watcher = libChokidar.watch(this.folder,
			{
				ignoreInitial: true,
				ignored: (pPath) => /(^|[\/\\])\.|[\/\\](node_modules|app)([\/\\]|$)/.test(pPath)
			});
		this._watcher.on('all', () => this._scheduleReconcile());

		// Periodic safety-net reconcile behind the file watch.
		if (this.pollMs > 0) { this._timer = setInterval(() => this._reconcileSafe(), this.pollMs); }
		this._running = true;
	}

	async stop()
	{
		this._running = false;
		if (this._timer) { clearInterval(this._timer); this._timer = null; }
		if (this._debounceTimer) { clearTimeout(this._debounceTimer); this._debounceTimer = null; }
		if (this._watcher) { await this._watcher.close(); this._watcher = null; }
	}

	// Current state, for the Ultravisor DocSync 'Status' action.
	status()
	{
		return {
			Folder: this.folder,
			Running: this._running,
			LastReconcileAt: this.lastReconcileAt,
			LastSummary: this.lastSummary,
			PlatformCommit: (this._loadBase().PlatformCommit || '').slice(0, 12)
		};
	}
}

module.exports = DocumentationBeacon;
