'use strict';

/**
 * LoginFlow -- turns a human login into a fully configured node connection.
 *
 * One call, run(), performs the whole chain and never asks the operator to paste a token or run a curl:
 *   1. POST /1.0/Login  (and, if the account has 2FA, prompt for the emailed/texted code -> /1.0/Login/Verify)
 *   2. POST /1.0/Token  -> a durable pls_ personal token, used only in-flight for the admin steps below
 *   3. POST /1.0/Node/Provision { AgentName: <node name> }  -> the node's own pls_ token
 *   4. POST /1.0/Node/Self/Register { NodeKey }             -> a key minted on THIS machine (never leaves it before)
 *   5. POST /1.0/NodeRegistration/:id/Approve              -> Pending becomes Active
 *   6. GET  /1.0/Node/Self                                 -> confirm Active + a bound BeaconName
 *   7. write ~/.plansheet/nodes/<slug>.json               -> the runner's whole identity
 *
 * The interactive parts (the 2FA code, confirming the node name) come in as injected async callbacks so the flow
 * is exercised end to end in tests without a TTY. The user's account token is used and discarded; only the
 * narrowed, revocable node token is persisted.
 *
 * @author Steven Velozo <steven@velozo.com>
 * @license MIT
 */

const libOS = require('os');

const libNodeIdentity = require('./NodeIdentity.js');

const MAX_CODE_ATTEMPTS = 5;

class LoginFlow
{
	// pDeps: { Client (PlansheetClient), Config (ClientConfig), Prompts?, Log?, Host? }
	// Prompts (all async, all optional): code(pChallenge, pPreviousError) -> String; nodeName(pDefault) -> String; notify(pMessage)
	constructor(pDeps)
	{
		let tmpDeps = pDeps || {};
		if (!tmpDeps.Client) { throw new Error('LoginFlow: a Client is required.'); }
		if (!tmpDeps.Config) { throw new Error('LoginFlow: a Config is required.'); }
		this._Client = tmpDeps.Client;
		this._Config = tmpDeps.Config;
		this._Prompts = tmpDeps.Prompts || {};
		this._Log = tmpDeps.Log || console;
		this._Host = (tmpDeps.Host !== undefined && tmpDeps.Host !== null) ? tmpDeps.Host : (libOS.hostname() || 'host');
	}

	_notify(pMessage)
	{
		if (typeof this._Prompts.notify === 'function') { try { this._Prompts.notify(pMessage); } catch (pIgnore) { /* progress is best-effort */ } }
	}

	// pOptions: { PlansheetURL, HubURL, UserName, Password, NodeName?, Label?, Capabilities? }
	async run(pOptions)
	{
		let tmpOptions = pOptions || {};
		if (!tmpOptions.PlansheetURL) { throw new Error('LoginFlow: PlansheetURL is required.'); }
		if (!tmpOptions.UserName) { throw new Error('LoginFlow: a user name / email is required.'); }
		if (!tmpOptions.Password) { throw new Error('LoginFlow: a password is required.'); }

		// 1. Authenticate (with 2FA if the account requires it).
		let tmpSessionID = await this._authenticate(tmpOptions.UserName, tmpOptions.Password);

		// 2. Mint a durable personal token for the admin steps; it is discarded when run() returns.
		this._notify('Authenticated. Preparing your node...');
		let tmpUserToken = (await this._Client.mintToken('plansheet-node CLI', { SessionID: tmpSessionID })).Token;

		// 3. Name and provision the node.
		let tmpNodeName = await this._resolveNodeName(tmpOptions);
		this._notify('Provisioning node "' + tmpNodeName + '"...');
		let tmpProvision = await this._Client.provisionNode({ AgentName: tmpNodeName, Label: tmpOptions.Label || tmpNodeName }, { Bearer: tmpUserToken });
		let tmpNodeToken = tmpProvision.Token;
		let tmpRegistration = tmpProvision.NodeRegistration || {};
		let tmpIDRegistration = tmpRegistration.IDNodeRegistration;
		if (!(parseInt(tmpIDRegistration, 10) > 0)) { throw new Error('Provision did not return a NodeRegistration id.'); }

		// 4. Self-register a key minted on this machine (set-once, forms the BeaconName server-side).
		let tmpNodeKey = libNodeIdentity.generateNodeKey(this._Host);
		await this._Client.registerSelf(
			{ NodeKey: tmpNodeKey, NodeHost: String(this._Host), CapabilityJSON: tmpOptions.Capabilities },
			{ Bearer: tmpNodeToken });

		// 5. Approve it (the user holds content.approve; the node token cannot approve itself).
		await this._Client.approveNode(tmpIDRegistration, { Bearer: tmpUserToken });

		// 6. Confirm the node is live and has a bound BeaconName.
		let tmpSelf = await this._Client.nodeSelf({ Bearer: tmpNodeToken });
		if (tmpSelf.Active !== true && tmpSelf.Status !== 'Active')
		{
			throw new Error('Node did not reach Active after approval (status: ' + (tmpSelf.Status || 'unknown') + ').');
		}
		if (!tmpSelf.BeaconName) { throw new Error('Node is Active but has no BeaconName; its NodeKey did not register.'); }

		// 7. Persist the connection.
		let tmpRecord =
		{
			NodeName: tmpNodeName,
			NodeKey: tmpNodeKey,
			BeaconName: tmpSelf.BeaconName,
			IDNodeRegistration: parseInt(tmpIDRegistration, 10),
			IDCustomer: tmpSelf.IDCustomer,
			PlansheetURL: this._Client.baseURL,
			HubURL: tmpOptions.HubURL || '',
			NodeToken: tmpNodeToken
		};
		let tmpPath = this._Config.saveNode(tmpRecord);
		this._notify('Connected. Saved ' + tmpPath);

		// Return a token-free summary for display; the token stays in the file only.
		return {
			NodeName: tmpNodeName,
			NodeKey: tmpNodeKey,
			BeaconName: tmpSelf.BeaconName,
			IDNodeRegistration: tmpRecord.IDNodeRegistration,
			IDCustomer: tmpSelf.IDCustomer,
			PlansheetURL: tmpRecord.PlansheetURL,
			HubURL: tmpRecord.HubURL,
			ConfigPath: tmpPath
		};
	}

	// Returns a SessionID. Handles the 2FA challenge with a bounded retry loop on wrong codes.
	async _authenticate(pUserName, pPassword)
	{
		let tmpLogin = await this._Client.login(pUserName, pPassword);
		if (!tmpLogin.Challenge)
		{
			if (!tmpLogin.SessionID) { throw new Error('Login succeeded but returned no session.'); }
			return tmpLogin.SessionID;
		}

		if (typeof this._Prompts.code !== 'function')
		{
			throw new Error('This account requires a 2FA code, but no way to enter one was provided.');
		}
		this._notify('A 2FA code was sent via ' + (tmpLogin.Channel || 'email') + (tmpLogin.MaskedDestination ? (' to ' + tmpLogin.MaskedDestination) : '') + '.');

		let tmpPreviousError = null;
		for (let tmpAttempt = 0; tmpAttempt < MAX_CODE_ATTEMPTS; tmpAttempt++)
		{
			let tmpCode = await this._Prompts.code(tmpLogin, tmpPreviousError);
			if (!tmpCode) { throw new Error('No 2FA code entered.'); }
			try
			{
				let tmpVerify = await this._Client.verifyLogin(tmpLogin.ChallengeToken, tmpCode);
				if (!tmpVerify.SessionID) { throw new Error('2FA verified but returned no session.'); }
				return tmpVerify.SessionID;
			}
			catch (pError)
			{
				// A wrong code is retryable while attempts remain; anything else (or attempts exhausted) is fatal.
				if (pError.AttemptsRemaining !== undefined && pError.AttemptsRemaining !== null && pError.AttemptsRemaining > 0)
				{
					tmpPreviousError = pError;
					continue;
				}
				throw pError;
			}
		}
		throw new Error('Too many incorrect 2FA codes.');
	}

	// Explicit name wins; otherwise generate a default (ordinal = local nodes for this URL + 1) and let the user confirm.
	async _resolveNodeName(pOptions)
	{
		if (pOptions.NodeName) { return String(pOptions.NodeName).trim(); }
		let tmpOrdinal = this._nextOrdinalFor(this._Client.baseURL);
		let tmpDefault = libNodeIdentity.generateNodeName({ Ordinal: tmpOrdinal, Seed: this._Host });
		if (typeof this._Prompts.nodeName === 'function')
		{
			let tmpChosen = await this._Prompts.nodeName(tmpDefault);
			return (tmpChosen && String(tmpChosen).trim()) ? String(tmpChosen).trim() : tmpDefault;
		}
		return tmpDefault;
	}

	// How many nodes this machine already has saved for this plansheet URL, +1.
	_nextOrdinalFor(pURL)
	{
		let tmpExisting = 0;
		try
		{
			let tmpNodes = this._Config.listNodes();
			for (let i = 0; i < tmpNodes.length; i++)
			{
				if (String(tmpNodes[i].PlansheetURL || '') === String(pURL || '')) { tmpExisting++; }
			}
		}
		catch (pIgnore) { tmpExisting = 0; }
		return tmpExisting + 1;
	}
}

module.exports = LoginFlow;
