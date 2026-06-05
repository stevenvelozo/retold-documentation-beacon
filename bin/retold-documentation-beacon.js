#!/usr/bin/env node
'use strict';

/**
 * retold-documentation-beacon CLI.
 *
 *   retold-documentation-beacon --folder ./docs --server http://localhost:8190 \
 *       --user dev@local.test --password devpass1234 [--once] [--poll-ms 30000] \
 *       [--ultravisor http://localhost:8086] [--name retold-documentation-beacon]
 *
 * Config also comes from a JSON file (--config beacon.json) or env vars
 * (DOCSYNC_SERVER / DOCSYNC_FOLDER / DOCSYNC_USER / DOCSYNC_PASSWORD /
 * DOCSYNC_ULTRAVISOR). CLI args win, then the config file, then env, then
 * defaults. When --ultravisor is set the beacon registers a supervised DocSync
 * capability (Reconcile / Status); otherwise it runs standalone.
 */

const libPath = require('path');
const libFS = require('fs');
const libDocumentationBeacon = require('../source/Documentation-Beacon.js');

function arg(pName, pDefault) { let tmpI = process.argv.indexOf('--' + pName); return (tmpI >= 0 && process.argv[tmpI + 1]) ? process.argv[tmpI + 1] : pDefault; }
function flag(pName) { return process.argv.includes('--' + pName); }

let tmpFileConfig = {};
let tmpConfigPath = arg('config');
if (tmpConfigPath) { tmpFileConfig = JSON.parse(libFS.readFileSync(libPath.resolve(tmpConfigPath), 'utf8')); }

let tmpOptions =
{
	Folder: arg('folder', tmpFileConfig.Folder || process.env.DOCSYNC_FOLDER || './docs'),
	ServerURL: arg('server', tmpFileConfig.ServerURL || process.env.DOCSYNC_SERVER || 'http://localhost:8190'),
	UserName: arg('user', tmpFileConfig.UserName || process.env.DOCSYNC_USER || ''),
	Password: arg('password', tmpFileConfig.Password || process.env.DOCSYNC_PASSWORD || ''),
	PollMs: Number(arg('poll-ms', tmpFileConfig.PollMs || 30000))
};

let tmpUltravisorURL = arg('ultravisor', tmpFileConfig.UltravisorURL || process.env.DOCSYNC_ULTRAVISOR || '');
let tmpBeaconName = arg('name', tmpFileConfig.Name || process.env.DOCSYNC_NAME || 'retold-documentation-beacon');

(async () =>
{
	let tmpBeacon = new libDocumentationBeacon(tmpOptions);
	if (flag('once'))
	{
		await tmpBeacon.client.authenticate();
		let tmpResult = await tmpBeacon.reconcileOnce();
		console.log('Reconcile complete: ' + JSON.stringify(tmpResult));
		process.exit(0);
	}
	await tmpBeacon.start();
	console.log('retold-documentation-beacon running (' + tmpOptions.Folder + ' <-> ' + tmpOptions.ServerURL + '). Ctrl+C to stop.');

	let tmpUltravisorService = null;
	if (tmpUltravisorURL)
	{
		const libUltravisorDocSync = require('../source/Ultravisor-DocSync.js');
		try
		{
			tmpUltravisorService = await libUltravisorDocSync.connect(tmpBeacon,
				{
					ServerURL: tmpUltravisorURL,
					Name: tmpBeaconName,
					UserName: tmpOptions.UserName,
					Password: tmpOptions.Password
				});
			console.log('Ultravisor supervision enabled: DocSync capability registered at ' + tmpUltravisorURL);
		}
		catch (pUVError)
		{
			console.error('Ultravisor supervision unavailable (' + (pUVError.message || pUVError) + '); continuing standalone.');
		}
	}

	process.on('SIGINT', async () =>
	{
		if (tmpUltravisorService && typeof tmpUltravisorService.disable === 'function') { try { tmpUltravisorService.disable(() => {}); } catch (pErr) { /* best effort */ } }
		await tmpBeacon.stop();
		process.exit(0);
	});
})().catch((pErr) => { console.error('beacon failed: ' + (pErr.message || pErr)); process.exit(1); });
