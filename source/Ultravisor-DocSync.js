'use strict';

/**
 * Ultravisor-DocSync - optional supervision for the documentation beacon.
 *
 * Registers a DocSync capability (Reconcile / Status actions) on an
 * ultravisor-beacon service and enables it against an Ultravisor coordinator,
 * so reconciles run as supervised, health-tracked work items and a scheduled
 * Reconcile is a safety net behind the chokidar watch. Both ultravisor-beacon
 * and fable are optional requires; connect() rejects with a clear error when
 * either is absent and the beacon keeps running standalone.
 *
 * The capability handlers are thin wrappers over the beacon's already-verified
 * reconcileOnce()/status() so supervised behaviour reuses the same engine the
 * standalone watch uses.
 *
 *   const tmpUV = require('./Ultravisor-DocSync.js');
 *   if (tmpUV.available) { await tmpUV.connect(tmpBeacon, { ServerURL, Name, UserName, Password }); }
 *
 * @author Steven Velozo <steven@velozo.com>
 */

let libBeaconService = null;
try { libBeaconService = require('ultravisor-beacon'); } catch (pError) { /* optional at load time */ }

let libFable = null;
try { libFable = require('fable'); } catch (pError) { /* optional at load time */ }

/**
 * Register the DocSync capability (Reconcile + Status) on a beacon service.
 *
 * @param {object} pBeaconService an instantiated ultravisor-beacon service
 * @param {object} pBeacon the DocumentationBeacon instance to drive
 */
function registerDocSyncCapability(pBeaconService, pBeacon)
{
	pBeaconService.registerCapability(
		{
			Capability: 'DocSync',
			Name: 'DocSyncProvider',
			actions:
			{
				'Reconcile':
				{
					Description: 'Reconcile the watched documentation folder with the Docs Lake (bidirectional 3-way merge).',
					SettingsSchema: [],
					Handler: function (pWorkItem, pContext, fHandlerCallback)
					{
						pBeacon.reconcileOnce()
							.then((pSummary) => fHandlerCallback(null, { Outputs: pSummary, Log: [] }))
							.catch((pError) => fHandlerCallback(pError));
					}
				},
				'Status':
				{
					Description: 'Report the watched folder, last reconcile summary, and conflict state.',
					SettingsSchema: [],
					Handler: function (pWorkItem, pContext, fHandlerCallback)
					{
						try
						{
							return fHandlerCallback(null, { Outputs: pBeacon.status(), Log: [] });
						}
						catch (pError)
						{
							return fHandlerCallback(pError);
						}
					}
				}
			}
		});
}

/**
 * Instantiate an ultravisor-beacon service, register DocSync, and enable it.
 *
 * @param {object} pBeacon the DocumentationBeacon instance
 * @param {object} pConfig { ServerURL (required), Name, UserName, Password, MaxConcurrent, Tags }
 * @returns {Promise<object>} the enabled beacon service
 */
function connect(pBeacon, pConfig)
{
	return new Promise((resolve, reject) =>
	{
		if (!libBeaconService) { return reject(new Error('ultravisor-beacon is not installed; cannot enable Ultravisor supervision.')); }
		if (!libFable) { return reject(new Error('fable is not installed; cannot host the Ultravisor beacon service.')); }
		if (!pConfig || !pConfig.ServerURL) { return reject(new Error('Ultravisor supervision requires a ServerURL.')); }

		let tmpFable = new libFable({ Product: 'RetoldDocumentationBeacon' });
		tmpFable.addServiceTypeIfNotExists('UltravisorBeacon', libBeaconService);

		let tmpService = tmpFable.instantiateServiceProviderWithoutRegistration('UltravisorBeacon',
			{
				ServerURL: pConfig.ServerURL,
				Name: pConfig.Name || 'retold-documentation-beacon',
				UserName: pConfig.UserName || '',
				Password: pConfig.Password || '',
				MaxConcurrent: pConfig.MaxConcurrent || 1,
				Tags: pConfig.Tags || {}
			});

		registerDocSyncCapability(tmpService, pBeacon);

		tmpService.enable((pError) =>
		{
			if (pError) { return reject(pError); }
			return resolve(tmpService);
		});
	});
}

module.exports = { connect, registerDocSyncCapability, available: !!libBeaconService };
