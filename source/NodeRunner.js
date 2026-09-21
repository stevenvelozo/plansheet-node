'use strict';

/**
 * NodeRunner -- holds a live connection from a saved node to the secured Ultravisor hub and executes the work the
 * hub dispatches.
 *
 * At start it re-reads GET /1.0/Node/Self with the node's token to confirm the registration is still Active and to
 * get the server-computed BeaconName, then joins the hub as a beacon whose Name is that BeaconName and whose
 * JoinSecret is the token. It advertises its harness capability so the hub routes matching work to it; without a
 * harness it joins but advertises nothing. A Pending, Suspended, Revoked, or unreachable node is turned away with
 * a clear reason so a supervisor can retry.
 *
 * decideStart and buildBeaconConfig are pure so the join logic is testable without a hub.
 *
 * @author Steven Velozo <steven@velozo.com>
 * @license MIT
 */

const libPlansheetClient = require('./PlansheetClient.js');

const NODE_TOKEN_KIND = 'node';
const ALLOWED_STATUS = 'Active';
const DEFAULT_HEARTBEAT_MS = 30000;

// The ultravisor-beacon client wants an http(s) ORIGIN, not a ws(s) URL: it derives the socket scheme itself
// (https -> wss, http -> ws) and uses the URL as-is for its HTTP auth leg. Handing it wss:// makes that HTTP leg
// hit http://, which a TLS-terminating nginx answers with a 301 redirect the beacon cannot parse. Accept the
// natural wss:///ws:// a user would type and map it back to the origin the library expects.
function normalizeHubURL(pURL)
{
	let tmpURL = String(pURL || '').trim();
	if (tmpURL.slice(0, 6).toLowerCase() === 'wss://') { return 'https://' + tmpURL.slice(6); }
	if (tmpURL.slice(0, 5).toLowerCase() === 'ws://') { return 'http://' + tmpURL.slice(5); }
	return tmpURL;
}

// Given the node's own selfView, decide whether to join and under what Name.
function decideStart(pSelfView)
{
	if (!pSelfView || typeof pSelfView !== 'object')
	{
		return { Proceed: false, Reason: 'No node self view was returned by plansheet.', BeaconName: '' };
	}
	if (String(pSelfView.TokenKind || '').trim() !== NODE_TOKEN_KIND)
	{
		return { Proceed: false, Reason: 'The saved token is not a node token; log in again to re-provision.', BeaconName: '' };
	}
	let tmpStatus = String(pSelfView.Status || '');
	if (pSelfView.Active !== true || tmpStatus !== ALLOWED_STATUS)
	{
		return { Proceed: false, Reason: 'Node registration is not Active (Status: ' + (tmpStatus || 'unknown') + ').', BeaconName: '' };
	}
	let tmpName = String(pSelfView.BeaconName || '').trim();
	if (!tmpName)
	{
		return { Proceed: false, Reason: 'Node registration has no beacon name yet (its NodeKey has not been registered).', BeaconName: '' };
	}
	return { Proceed: true, Reason: '', BeaconName: tmpName };
}

// Assemble the ultravisor-beacon BeaconClient config for a validated node. FailStartOnRejection is true so a
// refused join surfaces to start()'s callback instead of hanging.
function buildBeaconConfig(pSelfView, pOptions)
{
	let tmpOptions = pOptions || {};
	let tmpSelfView = pSelfView || {};
	let tmpHeartbeat = (Number.isFinite(tmpOptions.HeartbeatIntervalMs) && tmpOptions.HeartbeatIntervalMs > 0)
		? tmpOptions.HeartbeatIntervalMs : DEFAULT_HEARTBEAT_MS;
	let tmpProviders = Array.isArray(tmpOptions.Providers) ? tmpOptions.Providers : [];
	let tmpCapabilities = [];
	tmpProviders.forEach((pProvider) =>
	{
		if (pProvider && typeof pProvider.getCapabilities === 'function') { tmpCapabilities = tmpCapabilities.concat(pProvider.getCapabilities()); }
		else if (pProvider && pProvider.Capability) { tmpCapabilities.push(pProvider.Capability); }
	});
	return {
		ServerURL: tmpOptions.HubURL,
		Name: String(tmpSelfView.BeaconName || '').trim(),
		JoinSecret: tmpOptions.NodeToken,
		Providers: tmpProviders,
		Tags:
		{
			Role: 'plansheet-node',
			IDCustomer: tmpSelfView.IDCustomer || 0,
			IDNodeRegistration: tmpSelfView.IDNodeRegistration || 0,
			NodeKey: String(tmpSelfView.NodeKey || ''),
			Capabilities: tmpCapabilities.join(',')
		},
		HeartbeatIntervalMs: tmpHeartbeat,
		FailStartOnRejection: true,
		Log: tmpOptions.Log
	};
}

class NodeRunner
{
	// pConfig: { PlansheetURL, NodeToken, HubURL, Providers?|Harness?, HeartbeatIntervalMs?, RequestTimeoutMs?, Log?, Client? (PlansheetClient), BeaconClientFactory? (test seam) }
	constructor(pConfig)
	{
		let tmpConfig = pConfig || {};
		this._PlansheetURL = String(tmpConfig.PlansheetURL || '').replace(/\/+$/, '');
		this._NodeToken = tmpConfig.NodeToken || '';
		this._HubURL = normalizeHubURL(tmpConfig.HubURL);
		this._HeartbeatIntervalMs = tmpConfig.HeartbeatIntervalMs || DEFAULT_HEARTBEAT_MS;
		this._Log = tmpConfig.Log || console;

		if (Array.isArray(tmpConfig.Providers)) { this._Providers = tmpConfig.Providers; }
		else if (tmpConfig.Harness) { this._Providers = [ tmpConfig.Harness ]; }
		else { this._Providers = []; }

		// A PlansheetClient for the /1.0/Node/Self read; injectable for tests. Built lazily so a missing URL is a
		// clean start() reason rather than a constructor throw.
		this._Client = tmpConfig.Client || null;
		this._RequestTimeoutMs = tmpConfig.RequestTimeoutMs;

		// Test seam: replaces the real ultravisor-beacon client so start() is exercised without a live hub.
		this._BeaconClientFactory = (typeof tmpConfig.BeaconClientFactory === 'function') ? tmpConfig.BeaconClientFactory : null;
		this._Beacon = null;
	}

	_client()
	{
		if (this._Client) { return this._Client; }
		this._Client = new libPlansheetClient({ BaseURL: this._PlansheetURL, RequestTimeoutMs: this._RequestTimeoutMs, Log: this._Log });
		return this._Client;
	}

	_makeBeacon(pBeaconConfig)
	{
		if (this._BeaconClientFactory) { return this._BeaconClientFactory(pBeaconConfig); }
		let libBeaconClient = require('ultravisor-beacon').BeaconClient;
		return new libBeaconClient(pBeaconConfig);
	}

	async start()
	{
		if (!this._PlansheetURL) { return { Started: false, Reason: 'PlansheetURL is required.' }; }
		if (!this._NodeToken) { return { Started: false, Reason: 'A node token is required.' }; }
		if (!this._HubURL) { return { Started: false, Reason: 'A hub URL is required (login did not record one; pass --hub).' }; }

		let tmpSelfView;
		try { tmpSelfView = await this._client().nodeSelf({ Bearer: this._NodeToken }); }
		catch (pError) { return { Started: false, Reason: 'Could not resolve node identity: ' + pError.message }; }

		let tmpDecision = decideStart(tmpSelfView);
		if (!tmpDecision.Proceed) { return { Started: false, Reason: tmpDecision.Reason }; }

		let tmpBeaconConfig = buildBeaconConfig(tmpSelfView,
			{ HubURL: this._HubURL, NodeToken: this._NodeToken, HeartbeatIntervalMs: this._HeartbeatIntervalMs, Providers: this._Providers, Log: this._Log });
		this._Beacon = this._makeBeacon(tmpBeaconConfig);

		let tmpSelf = this;
		return new Promise((fResolve) =>
		{
			tmpSelf._Beacon.start((pError, pBeacon) =>
			{
				if (pError)
				{
					tmpSelf._Beacon = null;
					return fResolve({ Started: false, Reason: 'Beacon join was refused: ' + pError.message });
				}
				let tmpID = (pBeacon && (pBeacon.BeaconID || pBeacon.beaconID)) || tmpDecision.BeaconName;
				return fResolve({ Started: true, Reason: '', BeaconName: tmpDecision.BeaconName, BeaconID: tmpID });
			});
		});
	}

	stop(fCallback)
	{
		if (!this._Beacon || typeof this._Beacon.stop !== 'function') { return fCallback ? fCallback(null) : null; }
		this._Beacon.stop(fCallback || (() => {}));
	}
}

module.exports = NodeRunner;
module.exports.decideStart = decideStart;
module.exports.buildBeaconConfig = buildBeaconConfig;
module.exports.normalizeHubURL = normalizeHubURL;
