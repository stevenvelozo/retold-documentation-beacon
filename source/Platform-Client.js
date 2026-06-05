'use strict';

/**
 * Platform-Client - the HTTP client the documentation beacon uses to talk to a
 * Retold Docs Lake over /1.0/docs/*. Session-cookie auth: it logs
 * in once with a service account and replays the cookie on every request.
 *
 *   authenticate()         sign in, capture the session cookie
 *   getManifest()          { Commit, Tree: { path: { Hash, Size, Mime } } }
 *   getDoc(path)           the bytes at a path (Buffer)
 *   commit(changeset)      POST a { Puts, Deletes, Conflicts } changeset
 *
 * Uses the node global fetch (node 18+); no third-party HTTP dependency.
 */
class PlatformClient
{
	constructor(pOptions)
	{
		let tmpOptions = pOptions || {};
		this.serverURL = String(tmpOptions.ServerURL || 'http://localhost:8190').replace(/\/+$/, '');
		this.userName = tmpOptions.UserName || '';
		this.password = tmpOptions.Password || '';
		this.log = tmpOptions.Log || console;
		this._cookie = '';
	}

	_url(pPath) { return this.serverURL + (pPath.charAt(0) === '/' ? pPath : '/' + pPath); }

	_headers(pExtra)
	{
		let tmpHeaders = Object.assign({ 'Accept': 'application/json' }, pExtra || {});
		if (this._cookie) { tmpHeaders['Cookie'] = this._cookie; }
		return tmpHeaders;
	}

	// Capture the session cookie(s) from a response (just the name=value parts).
	_captureCookies(pResponse)
	{
		let tmpJar = (typeof pResponse.headers.getSetCookie === 'function')
			? pResponse.headers.getSetCookie()
			: (pResponse.headers.get('set-cookie') ? [pResponse.headers.get('set-cookie')] : []);
		if (tmpJar && tmpJar.length)
		{
			this._cookie = tmpJar.map((pC) => String(pC).split(';')[0]).join('; ');
		}
	}

	async authenticate()
	{
		let tmpResponse = await fetch(this._url('/1.0/Authenticate'),
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
				body: JSON.stringify({ UserName: this.userName, Password: this.password })
			});
		if (!tmpResponse.ok) { throw new Error('Authentication failed (HTTP ' + tmpResponse.status + ')'); }
		this._captureCookies(tmpResponse);
		if (!this._cookie) { throw new Error('Authentication succeeded but no session cookie was returned.'); }
		return true;
	}

	async getManifest()
	{
		let tmpResponse = await fetch(this._url('/1.0/docs/manifest'), { headers: this._headers() });
		if (!tmpResponse.ok) { throw new Error('getManifest failed (HTTP ' + tmpResponse.status + ')'); }
		let tmpBody = await tmpResponse.json();
		return { Commit: tmpBody.Commit || '', Tree: tmpBody.Tree || {} };
	}

	async getDoc(pPath)
	{
		let tmpResponse = await fetch(this._url('/1.0/docs/' + String(pPath).replace(/^\/+/, '')), { headers: this._headers() });
		if (!tmpResponse.ok) { throw new Error('getDoc(' + pPath + ') failed (HTTP ' + tmpResponse.status + ')'); }
		let tmpArrayBuffer = await tmpResponse.arrayBuffer();
		return Buffer.from(tmpArrayBuffer);
	}

	async commit(pChangeset)
	{
		let tmpResponse = await fetch(this._url('/1.0/docs/commit'),
			{
				method: 'POST',
				headers: this._headers({ 'Content-Type': 'application/json' }),
				body: JSON.stringify(
					{
						Puts: pChangeset.Puts || {},
						Deletes: pChangeset.Deletes || [],
						Conflicts: pChangeset.Conflicts || [],
						Source: pChangeset.Source || 'beacon',
						Author: pChangeset.Author || 'documentation-beacon',
						Message: pChangeset.Message || 'Sync from folder'
					})
			});
		if (!tmpResponse.ok) { throw new Error('commit failed (HTTP ' + tmpResponse.status + ')'); }
		return tmpResponse.json();
	}
}

module.exports = PlatformClient;
