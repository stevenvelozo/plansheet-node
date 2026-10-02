'use strict';

/**
 * Prune: the selection + classification logic behind `plansheet-node prune`. Pure (no IO), so the rules that
 * decide which saved nodes a prune covers and whether a liveness probe should remove one are tested directly.
 *
 * The rule that matters most: prune only what the server has actually forgotten (401/403/404). A node that is
 * offline right now, or whose server errored, is kept -- pruning on a transient failure would throw away a live
 * node's only local token.
 */

const Chai = require('chai');
const Expect = Chai.expect;

const libPrune = require('../source/Prune.js');

suite('Prune', () =>
{
	suite('normalizeURL', () =>
	{
		test('trims and drops trailing slashes', () =>
		{
			Expect(libPrune.normalizeURL('https://dev.plansheet.io/')).to.equal('https://dev.plansheet.io');
			Expect(libPrune.normalizeURL('  https://dev.plansheet.io//  ')).to.equal('https://dev.plansheet.io');
			Expect(libPrune.normalizeURL('https://dev.plansheet.io')).to.equal('https://dev.plansheet.io');
		});

		test('empty / nullish becomes an empty string', () =>
		{
			Expect(libPrune.normalizeURL('')).to.equal('');
			Expect(libPrune.normalizeURL(null)).to.equal('');
			Expect(libPrune.normalizeURL(undefined)).to.equal('');
		});
	});

	suite('selectNodes', () =>
	{
		const NODES =
		[
			{ NodeName: 'devq', PlansheetURL: 'https://dev.plansheet.io' },
			{ NodeName: 'mac-models', PlansheetURL: 'https://dev.plansheet.io/' },
			{ NodeName: 'pictbook-prod', PlansheetURL: 'https://plansheet.io' }
		];

		test('no --url selects every saved node', () =>
		{
			Expect(libPrune.selectNodes(NODES, '').map((pN) => pN.NodeName)).to.deep.equal([ 'devq', 'mac-models', 'pictbook-prod' ]);
			Expect(libPrune.selectNodes(NODES, null).length).to.equal(3);
		});

		test('--url selects only that plan sheet, ignoring trailing-slash differences', () =>
		{
			let tmpPicked = libPrune.selectNodes(NODES, 'https://dev.plansheet.io/').map((pN) => pN.NodeName);
			Expect(tmpPicked).to.deep.equal([ 'devq', 'mac-models' ]);
		});

		test('--url that matches nothing selects nothing', () =>
		{
			Expect(libPrune.selectNodes(NODES, 'https://staging.plansheet.io')).to.deep.equal([]);
		});

		test('a non-array is treated as empty', () =>
		{
			Expect(libPrune.selectNodes(null, '')).to.deep.equal([]);
		});
	});

	suite('classifyProbe', () =>
	{
		test('a 2xx is alive and kept', () =>
		{
			Expect(libPrune.classifyProbe({ Reachable: true, StatusCode: 200 })).to.deep.equal({ State: 'alive', Remove: false });
			Expect(libPrune.classifyProbe({ Reachable: true, StatusCode: 204 })).to.deep.equal({ State: 'alive', Remove: false });
		});

		test('401 / 403 / 404 mean the server forgot this node -> dead, removed', () =>
		{
			[ 401, 403, 404 ].forEach((pCode) =>
			{
				Expect(libPrune.classifyProbe({ Reachable: true, StatusCode: pCode }), 'HTTP ' + pCode)
					.to.deep.equal({ State: 'dead', Remove: true });
			});
		});

		test('a 5xx is a server error, not authoritative about the node -> kept', () =>
		{
			Expect(libPrune.classifyProbe({ Reachable: true, StatusCode: 500 })).to.deep.equal({ State: 'error', Remove: false });
			Expect(libPrune.classifyProbe({ Reachable: true, StatusCode: 502 })).to.deep.equal({ State: 'error', Remove: false });
		});

		test('an unreachable server (transport failure) is kept, never pruned', () =>
		{
			Expect(libPrune.classifyProbe({ Reachable: false })).to.deep.equal({ State: 'unreachable', Remove: false });
			Expect(libPrune.classifyProbe(null)).to.deep.equal({ State: 'unreachable', Remove: false });
		});
	});
});
