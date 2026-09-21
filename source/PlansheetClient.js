'use strict';

/**
 * PlansheetClient -- a thin HTTP client for the plansheet REST surface the node client needs.
 *
 * It covers exactly the calls the login-to-connected flow makes: the two-step login (with 2FA), minting a durable
 * personal token, provisioning a node, the node self-registering its key, approval, and reading the node's own
 * registration back. Nothing here is plansheet-app specific; it is just the wire protocol.
 *
 * Authentication is passed per call, never held as ambient state, so the flow that owns the tokens decides which
 * credential each request carries:
 *   - SessionID  -> sent as the CTSessionID cookie (what a fresh /1.0/Login hands back)
 *   - Bearer     -> sent as Authorization: Bearer <token> (a pls_ personal or node token)
 *
 * Tokens are secrets. This client never logs a token, a password, or a 2FA code.
 *
 * @author Steven Velozo <steven@velozo.com>
 * @license MIT
 */

const COOKIE_NAME = 'CTSessionID';

class PlansheetClient
{
	constructor(pConfig)
	{
		let tmpConfig = pConfig || {};
		if (!tmpConfig.BaseURL) { throw new Error('PlansheetClient: BaseURL is required.'); }
		// Normalize: no trailing slash, so BaseURL + '/1.0/...' is always well formed.
		this._BaseURL = String(tmpConfig.BaseURL).replace(/\/+$/, '');
		this._Log = tmpConfig.Log || console;
		this._RequestTimeoutMs = Number(tmpConfig.RequestTimeoutMs) || 15000;
		// Test seam: a fetch(url, options) -> { status, text() }. Defaults to the global fetch (Node >= 18).
		this._Fetch = (typeof tmpConfig.Fetch === 'function') ? tmpConfig.Fetch : ((typeof fetch === 'function') ? fetch : null);
		if (!this._Fetch) { throw new Error('PlansheetClient: no fetch available; pass Fetch or run on Node >= 18.'); }
	}

	get baseURL() { return this._BaseURL; }

	// ----- login -----

	// POST /1.0/Login { UserName, Password }
	// Returns the raw body: either { LoggedIn:true, SessionID, ... } or { LoggedIn:false, Challenge:true, ChallengeToken, Channel, MaskedDestination, ExpiresInSeconds }.
	async login(pUserName, pPassword)
	{
		let tmpResult = await this._request('POST', '/1.0/Login', { Body: { UserName: pUserName, Password: pPassword } });
		// A 2FA challenge comes back as HTTP 200 with LoggedIn:false; only a real auth failure is non-2xx.
		if (tmpResult.StatusCode === 401) { throw new Error('Login failed: check the email and password.'); }
		this._expectOK(tmpResult, 'Login');
		return tmpResult.Body || {};
	}

	// POST /1.0/Login/Verify { ChallengeToken, Code } -> { LoggedIn:true, SessionID, ... }
	async verifyLogin(pChallengeToken, pCode)
	{
		let tmpResult = await this._request('POST', '/1.0/Login/Verify', { Body: { ChallengeToken: pChallengeToken, Code: String(pCode) } });
		if (tmpResult.StatusCode === 401)
		{
			let tmpRemaining = (tmpResult.Body && tmpResult.Body.AttemptsRemaining !== undefined) ? tmpResult.Body.AttemptsRemaining : null;
			let tmpError = new Error('That code was not accepted.' + (tmpRemaining !== null ? (' Attempts remaining: ' + tmpRemaining + '.') : ''));
			tmpError.AttemptsRemaining = tmpRemaining;
			throw tmpError;
		}
		this._expectOK(tmpResult, 'Login/Verify');
		return tmpResult.Body || {};
	}

	// POST /1.0/Login/Resend { ChallengeToken } -> reissues a fresh code on the same challenge.
	async resendCode(pChallengeToken)
	{
		let tmpResult = await this._request('POST', '/1.0/Login/Resend', { Body: { ChallengeToken: pChallengeToken } });
		this._expectOK(tmpResult, 'Login/Resend');
		return tmpResult.Body || {};
	}

	// ----- tokens -----

	// POST /1.0/Token { Label } (session cookie or bearer) -> { Token, UserToken }. Durable pls_ personal token.
	async mintToken(pLabel, pAuth)
	{
		let tmpResult = await this._request('POST', '/1.0/Token', { Body: { Label: pLabel || 'plansheet-node' }, Auth: pAuth });
		this._expectOK(tmpResult, 'Token');
		if (!tmpResult.Body || !tmpResult.Body.Token) { throw new Error('Token mint returned no token.'); }
		return tmpResult.Body;
	}

	// ----- node lifecycle -----

	// POST /1.0/Node/Provision { AgentName | IDAgentUser, Label? } (user bearer) -> { Token (node token), NodeRegistration, Agent }.
	async provisionNode(pOptions, pAuth)
	{
		let tmpBody = {};
		if (pOptions && pOptions.IDAgentUser) { tmpBody.IDAgentUser = pOptions.IDAgentUser; }
		else { tmpBody.AgentName = String((pOptions && pOptions.AgentName) || '').trim(); }
		if (pOptions && pOptions.Label) { tmpBody.Label = pOptions.Label; }
		let tmpResult = await this._request('POST', '/1.0/Node/Provision', { Body: tmpBody, Auth: pAuth });
		if (tmpResult.StatusCode === 403) { throw new Error('Not allowed to provision a node (needs the Owner or Admin role on this plan sheet).'); }
		this._expectOK(tmpResult, 'Node/Provision');
		if (!tmpResult.Body || !tmpResult.Body.Token || !tmpResult.Body.NodeRegistration) { throw new Error('Provision returned an incomplete response.'); }
		return tmpResult.Body;
	}

	// POST /1.0/Node/Self/Register { NodeHost?, NodeKey?, CapabilityJSON? } (node bearer). NodeKey is set-once.
	async registerSelf(pOptions, pAuth)
	{
		let tmpBody = {};
		if (pOptions && pOptions.NodeHost) { tmpBody.NodeHost = pOptions.NodeHost; }
		if (pOptions && pOptions.NodeKey) { tmpBody.NodeKey = pOptions.NodeKey; }
		if (pOptions && pOptions.CapabilityJSON !== undefined) { tmpBody.CapabilityJSON = pOptions.CapabilityJSON; }
		let tmpResult = await this._request('POST', '/1.0/Node/Self/Register', { Body: tmpBody, Auth: pAuth });
		if (tmpResult.StatusCode === 409) { throw new Error('This node already registered a different NodeKey; re-provision it to change identity.'); }
		this._expectOK(tmpResult, 'Node/Self/Register');
		return tmpResult.Body || {};
	}

	// POST /1.0/NodeRegistration/:id/Approve (user bearer) -> Pending becomes Active.
	async approveNode(pIDNodeRegistration, pAuth)
	{
		let tmpID = parseInt(pIDNodeRegistration, 10);
		if (!(tmpID > 0)) { throw new Error('approveNode: a NodeRegistration id is required.'); }
		let tmpResult = await this._request('POST', '/1.0/NodeRegistration/' + tmpID + '/Approve', { Body: {}, Auth: pAuth });
		if (tmpResult.StatusCode === 403) { throw new Error('Not allowed to approve a node (needs the Owner or Admin role on this plan sheet).'); }
		this._expectOK(tmpResult, 'NodeRegistration/Approve');
		return tmpResult.Body || {};
	}

	// GET /1.0/Node/Self (node bearer) -> the join-validation view: { Status, Active, BeaconName, IDCustomer, NodeKey, TokenKind, ... }.
	async nodeSelf(pAuth)
	{
		let tmpResult = await this._request('GET', '/1.0/Node/Self', { Auth: pAuth });
		this._expectOK(tmpResult, 'Node/Self');
		return tmpResult.Body || {};
	}

	// GET /1.0/Node/Agents (user bearer) -> agents with ActiveNodeCount, used to pick a default node name/ordinal.
	async listAgents(pAuth)
	{
		let tmpResult = await this._request('GET', '/1.0/Node/Agents', { Auth: pAuth });
		this._expectOK(tmpResult, 'Node/Agents');
		return tmpResult.Body || {};
	}

	// ----- run reporting (the node writes its own step + run over REST) -----

	// PUT /1.0/RunStep/:id -- advance a run step (Status/StageLabel/HeartbeatDate/Log/...). Auto-CRUD update, so
	// the id rides both the path and the body.
	async putRunStep(pIDRunStep, pFields, pAuth)
	{
		let tmpID = parseInt(pIDRunStep, 10);
		if (!(tmpID > 0)) { throw new Error('putRunStep: a RunStep id is required.'); }
		let tmpResult = await this._request('PUT', '/1.0/RunStep/' + tmpID, { Body: Object.assign({ IDRunStep: tmpID }, pFields || {}), Auth: pAuth });
		this._expectOK(tmpResult, 'RunStep update');
		return tmpResult.Body || {};
	}

	// PUT /1.0/Run/:id -- close a run (Status/FinishedDate/ResultLog).
	async putRun(pIDRun, pFields, pAuth)
	{
		let tmpID = parseInt(pIDRun, 10);
		if (!(tmpID > 0)) { throw new Error('putRun: a Run id is required.'); }
		let tmpResult = await this._request('PUT', '/1.0/Run/' + tmpID, { Body: Object.assign({ IDRun: tmpID }, pFields || {}), Auth: pAuth });
		this._expectOK(tmpResult, 'Run update');
		return tmpResult.Body || {};
	}

	// ----- internals -----

	// pOptions: { Body?, Auth? } where Auth is { SessionID } (cookie) or { Bearer } (token). Returns { StatusCode, Body }.
	async _request(pMethod, pPath, pOptions)
	{
		let tmpOptions = pOptions || {};
		let tmpHeaders = { 'Accept': 'application/json' };
		let tmpAuth = tmpOptions.Auth || {};
		if (tmpAuth.Bearer) { tmpHeaders['Authorization'] = 'Bearer ' + tmpAuth.Bearer; }
		else if (tmpAuth.SessionID) { tmpHeaders['Cookie'] = COOKIE_NAME + '=' + tmpAuth.SessionID; }
		// A node authorized for many plan sheets targets one per request with X-Plansheet-Customer (an IDCustomer
		// or a plan sheet Code). The server validates it against the node's authorized set and scopes the write to
		// it. Omitted for a single-tenant node, which just acts in its home plan sheet.
		if (tmpAuth.Customer !== undefined && tmpAuth.Customer !== null && String(tmpAuth.Customer) !== '' && String(tmpAuth.Customer) !== '0')
		{
			tmpHeaders['X-Plansheet-Customer'] = String(tmpAuth.Customer);
		}

		let tmpFetchOptions = { method: pMethod, headers: tmpHeaders };
		if (tmpOptions.Body !== undefined)
		{
			tmpHeaders['Content-Type'] = 'application/json';
			tmpFetchOptions.body = JSON.stringify(tmpOptions.Body);
		}

		// Owned deadline: a hung server should surface as a clean error, not a wedged CLI.
		let tmpController = (typeof AbortController === 'function') ? new AbortController() : null;
		let tmpTimer = null;
		if (tmpController)
		{
			tmpFetchOptions.signal = tmpController.signal;
			tmpTimer = setTimeout(() => { try { tmpController.abort(); } catch (pIgnore) { /* already done */ } }, this._RequestTimeoutMs);
			if (tmpTimer.unref) { tmpTimer.unref(); }
		}

		let tmpResponse;
		try { tmpResponse = await this._Fetch(this._BaseURL + pPath, tmpFetchOptions); }
		catch (pError)
		{
			if (tmpTimer) { clearTimeout(tmpTimer); }
			throw new Error('Could not reach plansheet at ' + this._BaseURL + ' (' + (pError && pError.message ? pError.message : 'request failed') + ').');
		}
		if (tmpTimer) { clearTimeout(tmpTimer); }

		let tmpText = '';
		try { tmpText = await tmpResponse.text(); } catch (pIgnore) { tmpText = ''; }
		let tmpBody = null;
		if (tmpText)
		{
			try { tmpBody = JSON.parse(tmpText); } catch (pIgnore) { tmpBody = { Raw: tmpText }; }
		}
		return { StatusCode: tmpResponse.status, Body: tmpBody };
	}

	// Throw a clean error for any non-2xx that the typed methods have not already special-cased.
	_expectOK(pResult, pWhat)
	{
		if (pResult.StatusCode >= 200 && pResult.StatusCode < 300) { return; }
		let tmpMessage = (pResult.Body && (pResult.Body.Error || pResult.Body.Message)) ? (pResult.Body.Error || pResult.Body.Message) : ('HTTP ' + pResult.StatusCode);
		throw new Error(pWhat + ' failed: ' + tmpMessage);
	}
}

module.exports = PlansheetClient;
