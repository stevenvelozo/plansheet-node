'use strict';

/**
 * Tests for PlansheetClient -- the HTTP wire client. A fake fetch stands in for the network, so every request
 * shape (method, path, auth header, body) and every response branch is exercised without a live server.
 */

const Chai = require('chai');
const Expect = Chai.expect;

const libPlansheetClient = require('../source/PlansheetClient.js');

// pRoutes: [{ method, path, status, body }] matched by (method, url endsWith path). Records every call.
function fakeFetch(pRoutes)
{
	let tmpCalls = [];
	let fFetch = async (pURL, pOptions) =>
	{
		tmpCalls.push({ URL: pURL, Options: pOptions });
		for (let i = 0; i < pRoutes.length; i++)
		{
			let tmpRoute = pRoutes[i];
			if (pOptions.method === tmpRoute.method && String(pURL).endsWith(tmpRoute.path))
			{
				return { status: tmpRoute.status, text: async () => (tmpRoute.body === undefined ? '' : JSON.stringify(tmpRoute.body)) };
			}
		}
		return { status: 404, text: async () => JSON.stringify({ Error: 'no route for ' + pOptions.method + ' ' + pURL }) };
	};
	fFetch.Calls = tmpCalls;
	return fFetch;
}

function client(pFetch)
{
	return new libPlansheetClient({ BaseURL: 'https://plansheet.example/', Fetch: pFetch });
}

suite('PlansheetClient', () =>
{
	test('login returns the session body when 2FA is not required', async () =>
	{
		let tmpFetch = fakeFetch([ { method: 'POST', path: '/1.0/Login', status: 200, body: { LoggedIn: true, SessionID: 'sess-1', UserRecord: {} } } ]);
		let tmpBody = await client(tmpFetch).login('a@b.com', 'pw');
		Expect(tmpBody.LoggedIn).to.equal(true);
		Expect(tmpBody.SessionID).to.equal('sess-1');
		// BaseURL trailing slash is normalized away.
		Expect(tmpFetch.Calls[0].URL).to.equal('https://plansheet.example/1.0/Login');
	});

	test('login returns the challenge envelope when 2FA is required (HTTP 200, LoggedIn false)', async () =>
	{
		let tmpFetch = fakeFetch([ { method: 'POST', path: '/1.0/Login', status: 200, body: { LoggedIn: false, Challenge: true, ChallengeToken: 'ct-9', Channel: 'email', MaskedDestination: 'a***@b.com' } } ]);
		let tmpBody = await client(tmpFetch).login('a@b.com', 'pw');
		Expect(tmpBody.Challenge).to.equal(true);
		Expect(tmpBody.ChallengeToken).to.equal('ct-9');
	});

	test('login throws a clean error on 401', async () =>
	{
		let tmpFetch = fakeFetch([ { method: 'POST', path: '/1.0/Login', status: 401, body: { Error: 'nope' } } ]);
		let tmpThrew = false;
		try { await client(tmpFetch).login('a@b.com', 'bad'); } catch (pError) { tmpThrew = true; Expect(pError.message).to.contain('email and password'); }
		Expect(tmpThrew).to.equal(true);
	});

	test('verifyLogin returns the session on success', async () =>
	{
		let tmpFetch = fakeFetch([ { method: 'POST', path: '/1.0/Login/Verify', status: 200, body: { LoggedIn: true, SessionID: 'sess-2' } } ]);
		let tmpBody = await client(tmpFetch).verifyLogin('ct-9', '123456');
		Expect(tmpBody.SessionID).to.equal('sess-2');
	});

	test('verifyLogin throws with AttemptsRemaining on a wrong code', async () =>
	{
		let tmpFetch = fakeFetch([ { method: 'POST', path: '/1.0/Login/Verify', status: 401, body: { AttemptsRemaining: 3 } } ]);
		let tmpError = null;
		try { await client(tmpFetch).verifyLogin('ct-9', '000000'); } catch (pError) { tmpError = pError; }
		Expect(tmpError).to.be.an('error');
		Expect(tmpError.AttemptsRemaining).to.equal(3);
	});

	test('mintToken sends the session cookie and returns the token', async () =>
	{
		let tmpFetch = fakeFetch([ { method: 'POST', path: '/1.0/Token', status: 200, body: { Success: true, Token: 'pls_user', UserToken: {} } } ]);
		let tmpBody = await client(tmpFetch).mintToken('label', { SessionID: 'sess-2' });
		Expect(tmpBody.Token).to.equal('pls_user');
		Expect(tmpFetch.Calls[0].Options.headers['Cookie']).to.equal('CTSessionID=sess-2');
	});

	test('provisionNode sends a bearer token and the AgentName, returns the node token', async () =>
	{
		let tmpFetch = fakeFetch([ { method: 'POST', path: '/1.0/Node/Provision', status: 200, body: { Success: true, Token: 'pls_node', NodeRegistration: { IDNodeRegistration: 12 } } } ]);
		let tmpBody = await client(tmpFetch).provisionNode({ AgentName: 'Matchbook-001' }, { Bearer: 'pls_user' });
		Expect(tmpBody.Token).to.equal('pls_node');
		Expect(tmpBody.NodeRegistration.IDNodeRegistration).to.equal(12);
		Expect(tmpFetch.Calls[0].Options.headers['Authorization']).to.equal('Bearer pls_user');
		Expect(JSON.parse(tmpFetch.Calls[0].Options.body).AgentName).to.equal('Matchbook-001');
	});

	test('provisionNode maps a 403 to a role-hint error', async () =>
	{
		let tmpFetch = fakeFetch([ { method: 'POST', path: '/1.0/Node/Provision', status: 403, body: { Error: 'content.approve is required' } } ]);
		let tmpThrew = false;
		try { await client(tmpFetch).provisionNode({ AgentName: 'X' }, { Bearer: 'pls_user' }); } catch (pError) { tmpThrew = true; Expect(pError.message).to.contain('Owner or Admin'); }
		Expect(tmpThrew).to.equal(true);
	});

	test('registerSelf maps a 409 to a re-provision hint', async () =>
	{
		let tmpFetch = fakeFetch([ { method: 'POST', path: '/1.0/Node/Self/Register', status: 409, body: { Error: 'already has a different NodeKey' } } ]);
		let tmpThrew = false;
		try { await client(tmpFetch).registerSelf({ NodeKey: 'nk-x' }, { Bearer: 'pls_node' }); } catch (pError) { tmpThrew = true; Expect(pError.message).to.contain('re-provision'); }
		Expect(tmpThrew).to.equal(true);
	});

	test('approveNode posts to the id-scoped route and requires a positive id', async () =>
	{
		let tmpFetch = fakeFetch([ { method: 'POST', path: '/1.0/NodeRegistration/12/Approve', status: 200, body: { Success: true } } ]);
		await client(tmpFetch).approveNode(12, { Bearer: 'pls_user' });
		Expect(tmpFetch.Calls[0].URL).to.contain('/1.0/NodeRegistration/12/Approve');
		let tmpThrew = false;
		try { await client(tmpFetch).approveNode(0, { Bearer: 'pls_user' }); } catch (pError) { tmpThrew = true; }
		Expect(tmpThrew).to.equal(true);
	});

	test('nodeSelf sends the node bearer and returns the self view', async () =>
	{
		let tmpFetch = fakeFetch([ { method: 'GET', path: '/1.0/Node/Self', status: 200, body: { Status: 'Active', Active: true, BeaconName: 'ps.1.nk-x' } } ]);
		let tmpBody = await client(tmpFetch).nodeSelf({ Bearer: 'pls_node' });
		Expect(tmpBody.BeaconName).to.equal('ps.1.nk-x');
		Expect(tmpFetch.Calls[0].Options.headers['Authorization']).to.equal('Bearer pls_node');
	});

	test('putRunStep puts to the id-scoped route with the node bearer, id in path and body', async () =>
	{
		let tmpFetch = fakeFetch([ { method: 'PUT', path: '/1.0/RunStep/77', status: 200, body: { Success: true } } ]);
		await client(tmpFetch).putRunStep(77, { Status: 'Running' }, { Bearer: 'pls_node' });
		Expect(tmpFetch.Calls[0].URL).to.contain('/1.0/RunStep/77');
		Expect(tmpFetch.Calls[0].Options.headers['Authorization']).to.equal('Bearer pls_node');
		let tmpBody = JSON.parse(tmpFetch.Calls[0].Options.body);
		Expect(tmpBody.IDRunStep).to.equal(77);
		Expect(tmpBody.Status).to.equal('Running');
		// No target plan sheet named: a single-tenant node sends no X-Plansheet-Customer.
		Expect(tmpFetch.Calls[0].Options.headers['X-Plansheet-Customer']).to.equal(undefined);
	});

	test('a target plan sheet on Auth becomes the X-Plansheet-Customer header', async () =>
	{
		let tmpFetch = fakeFetch([ { method: 'PUT', path: '/1.0/RunStep/77', status: 200, body: { Success: true } } ]);
		await client(tmpFetch).putRunStep(77, { Status: 'Succeeded' }, { Bearer: 'pls_node', Customer: 23 });
		Expect(tmpFetch.Calls[0].Options.headers['X-Plansheet-Customer']).to.equal('23');
	});

	test('a zero or empty target plan sheet sends no X-Plansheet-Customer header', async () =>
	{
		let tmpFetch = fakeFetch([ { method: 'PUT', path: '/1.0/Run/5', status: 200, body: { Success: true } } ]);
		await client(tmpFetch).putRun(5, { Status: 'Succeeded' }, { Bearer: 'pls_node', Customer: 0 });
		Expect(tmpFetch.Calls[0].Options.headers['X-Plansheet-Customer']).to.equal(undefined);
	});

	test('capabilityPackages sends the node bearer and returns the Packages array', async () =>
	{
		let tmpFetch = fakeFetch([ { method: 'GET', path: '/1.0/CapabilityPackages/Available', status: 200, body: { Packages: [ { PackageKey: 'plansheet-query', Capability: 'plansheet.query', Manifest: { Actions: { RunSQL: {} } } } ] } } ]);
		let tmpPackages = await client(tmpFetch).capabilityPackages({ Bearer: 'pls_node' });
		Expect(tmpPackages.length).to.equal(1);
		Expect(tmpPackages[0].PackageKey).to.equal('plansheet-query');
		Expect(tmpFetch.Calls[0].Options.headers['Authorization']).to.equal('Bearer pls_node');
	});

	test('capabilityPackages returns an empty array when the body carries no Packages', async () =>
	{
		let tmpFetch = fakeFetch([ { method: 'GET', path: '/1.0/CapabilityPackages/Available', status: 200, body: {} } ]);
		let tmpPackages = await client(tmpFetch).capabilityPackages({ Bearer: 'pls_node' });
		Expect(tmpPackages).to.deep.equal([]);
	});

	test('a non-2xx with no special case throws a clean, tokenless error', async () =>
	{
		let tmpFetch = fakeFetch([ { method: 'POST', path: '/1.0/Token', status: 500, body: { Error: 'boom' } } ]);
		let tmpThrew = false;
		try { await client(tmpFetch).mintToken('label', { Bearer: 'pls_user' }); } catch (pError) { tmpThrew = true; Expect(pError.message).to.contain('boom'); }
		Expect(tmpThrew).to.equal(true);
	});

	test('a transport failure surfaces as an unreachable-plansheet error', async () =>
	{
		let fFetch = async () => { throw new Error('ECONNREFUSED'); };
		let tmpThrew = false;
		try { await client(fFetch).login('a@b.com', 'pw'); } catch (pError) { tmpThrew = true; Expect(pError.message).to.contain('Could not reach plansheet'); }
		Expect(tmpThrew).to.equal(true);
	});
});
