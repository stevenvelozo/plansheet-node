'use strict';

/**
 * Tests for LoginFlow -- the login-to-connected orchestration. A fake client and fake prompts drive every branch
 * (no-2FA, 2FA, wrong-then-right code, explicit vs generated node name, not-active failure) and assert the calls,
 * their auth credential, and that the user token is never returned to the caller.
 */

const Chai = require('chai');
const Expect = Chai.expect;

const libLoginFlow = require('../source/LoginFlow.js');

function fakeClient(pOverrides)
{
	let tmpCalls = [];
	let tmpBase =
	{
		baseURL: 'https://plansheet.example',
		login: async (pUser, pPass) => { tmpCalls.push({ m: 'login', pUser, pPass }); return { LoggedIn: true, SessionID: 'sess-1' }; },
		verifyLogin: async (pCT, pCode) => { tmpCalls.push({ m: 'verify', pCT, pCode }); return { SessionID: 'sess-2' }; },
		mintToken: async (pLabel, pAuth) => { tmpCalls.push({ m: 'mint', pAuth }); return { Token: 'pls_user' }; },
		provisionNode: async (pOpts, pAuth) => { tmpCalls.push({ m: 'provision', pOpts, pAuth }); return { Token: 'pls_node', NodeRegistration: { IDNodeRegistration: 5 } }; },
		registerSelf: async (pOpts, pAuth) => { tmpCalls.push({ m: 'register', pOpts, pAuth }); return {}; },
		approveNode: async (pID, pAuth) => { tmpCalls.push({ m: 'approve', pID, pAuth }); return {}; },
		nodeSelf: async (pAuth) => { tmpCalls.push({ m: 'self', pAuth }); return { Active: true, Status: 'Active', BeaconName: 'ps.1.nk-x', IDCustomer: 1 }; }
	};
	let tmpClient = Object.assign(tmpBase, pOverrides || {});
	tmpClient.Calls = tmpCalls;
	return tmpClient;
}

function fakeConfig()
{
	let tmpSaved = [];
	return {
		Saved: tmpSaved,
		listNodes: () => [],
		saveNode: (pRecord) => { tmpSaved.push(pRecord); return '/tmp/nodes/' + (pRecord.NodeName || 'x') + '.json'; }
	};
}

const SILENT_PROMPTS = { code: async () => '123456', nodeName: async (pDefault) => pDefault };

function flow(pClient, pConfig, pPrompts)
{
	return new libLoginFlow({ Client: pClient, Config: pConfig, Prompts: pPrompts || SILENT_PROMPTS, Host: 'testhost', Log: { info: () => {}, warn: () => {}, log: () => {} } });
}

function baseOptions(pOverrides)
{
	return Object.assign({ PlansheetURL: 'https://plansheet.example', HubURL: 'wss://hub', UserName: 'a@b.com', Password: 'pw' }, pOverrides || {});
}

suite('LoginFlow', () =>
{
	test('no-2FA happy path: provisions, registers, approves, verifies, and saves', async () =>
	{
		let tmpClient = fakeClient();
		let tmpConfig = fakeConfig();
		let tmpResult = await flow(tmpClient, tmpConfig).run(baseOptions());

		Expect(tmpResult.BeaconName).to.equal('ps.1.nk-x');
		Expect(tmpResult.IDNodeRegistration).to.equal(5);
		Expect(tmpResult.ConfigPath).to.contain('/tmp/nodes/');
		// No verify step when 2FA is not required.
		Expect(tmpClient.Calls.some((pC) => pC.m === 'verify')).to.equal(false);
		// The persisted record carries the node token; the returned summary does NOT.
		Expect(tmpConfig.Saved[0].NodeToken).to.equal('pls_node');
		Expect(tmpResult.NodeToken).to.equal(undefined);
	});

	test('the admin steps use the user token and the node steps use the node token', async () =>
	{
		let tmpClient = fakeClient();
		await flow(tmpClient, fakeConfig()).run(baseOptions());
		let fCall = (pName) => tmpClient.Calls.find((pC) => pC.m === pName);
		Expect(fCall('mint').pAuth.SessionID).to.equal('sess-1');
		Expect(fCall('provision').pAuth.Bearer).to.equal('pls_user');
		Expect(fCall('approve').pAuth.Bearer).to.equal('pls_user');
		Expect(fCall('register').pAuth.Bearer).to.equal('pls_node');
		Expect(fCall('self').pAuth.Bearer).to.equal('pls_node');
		// A NodeKey was minted on this machine and self-registered.
		Expect(fCall('register').pOpts.NodeKey).to.match(/^nk-testhost-[0-9a-f]{8}$/);
	});

	test('2FA path: prompts for the code and verifies', async () =>
	{
		let tmpClient = fakeClient({ login: async () => ({ LoggedIn: false, Challenge: true, ChallengeToken: 'ct-1', Channel: 'email' }) });
		let tmpCodeAsked = 0;
		let tmpResult = await flow(tmpClient, fakeConfig(), { code: async () => { tmpCodeAsked++; return '111111'; }, nodeName: async (pD) => pD }).run(baseOptions());
		Expect(tmpCodeAsked).to.equal(1);
		let tmpVerify = tmpClient.Calls.find((pC) => pC.m === 'verify');
		Expect(tmpVerify.pCT).to.equal('ct-1');
		Expect(tmpVerify.pCode).to.equal('111111');
		Expect(tmpResult.BeaconName).to.equal('ps.1.nk-x');
	});

	test('2FA retries on a wrong code, then succeeds', async () =>
	{
		let tmpVerifyCalls = 0;
		let tmpClient = fakeClient(
		{
			login: async () => ({ LoggedIn: false, Challenge: true, ChallengeToken: 'ct-1', Channel: 'email' }),
			verifyLogin: async (pCT, pCode) =>
			{
				tmpVerifyCalls++;
				if (tmpVerifyCalls === 1) { let tmpErr = new Error('bad code'); tmpErr.AttemptsRemaining = 4; throw tmpErr; }
				return { SessionID: 'sess-ok' };
			}
		});
		let tmpCodesAsked = 0;
		let tmpResult = await flow(tmpClient, fakeConfig(), { code: async () => { tmpCodesAsked++; return (tmpCodesAsked === 1) ? '000000' : '111111'; }, nodeName: async (pD) => pD }).run(baseOptions());
		Expect(tmpVerifyCalls).to.equal(2);
		Expect(tmpCodesAsked).to.equal(2);
		Expect(tmpResult.BeaconName).to.equal('ps.1.nk-x');
	});

	test('2FA required but no code prompt is fatal', async () =>
	{
		let tmpClient = fakeClient({ login: async () => ({ LoggedIn: false, Challenge: true, ChallengeToken: 'ct-1' }) });
		let tmpThrew = false;
		try { await new libLoginFlow({ Client: tmpClient, Config: fakeConfig(), Prompts: {}, Host: 'h' }).run(baseOptions()); }
		catch (pError) { tmpThrew = true; Expect(pError.message).to.contain('2FA'); }
		Expect(tmpThrew).to.equal(true);
	});

	test('an explicit node name is used verbatim and does not prompt', async () =>
	{
		let tmpClient = fakeClient();
		let tmpNameAsked = 0;
		await flow(tmpClient, fakeConfig(), { code: async () => '1', nodeName: async (pD) => { tmpNameAsked++; return pD; } }).run(baseOptions({ NodeName: 'Custom-9' }));
		Expect(tmpNameAsked).to.equal(0);
		Expect(tmpClient.Calls.find((pC) => pC.m === 'provision').pOpts.AgentName).to.equal('Custom-9');
	});

	test('a generated default name is offered and used when the prompt returns empty', async () =>
	{
		let tmpClient = fakeClient();
		let tmpOffered = null;
		await flow(tmpClient, fakeConfig(), { code: async () => '1', nodeName: async (pDefault) => { tmpOffered = pDefault; return ''; } }).run(baseOptions());
		Expect(tmpOffered).to.match(/-001$/);
		Expect(tmpClient.Calls.find((pC) => pC.m === 'provision').pOpts.AgentName).to.equal(tmpOffered);
	});

	test('a node that does not reach Active is a clean failure', async () =>
	{
		let tmpClient = fakeClient({ nodeSelf: async () => ({ Active: false, Status: 'Pending' }) });
		let tmpThrew = false;
		try { await flow(tmpClient, fakeConfig()).run(baseOptions()); }
		catch (pError) { tmpThrew = true; Expect(pError.message).to.contain('Active'); }
		Expect(tmpThrew).to.equal(true);
	});
});
