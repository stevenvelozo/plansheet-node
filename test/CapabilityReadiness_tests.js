'use strict';

/**
 * CapabilityReadiness: the node-side advertise gate for V51 F155 (WI-513). A capability is advertised only when
 * its package's declared Resources are satisfied on this box. Pure, so the whole gate is tested without hardware.
 */

const Chai = require('chai');
const Expect = Chai.expect;

const libReadiness = require('../source/CapabilityReadiness.js');

// A default context: 16 GB RAM, no GPU, 100 GB free disk, empty env, nothing on disk or PATH. Override per test.
function ctx(pOver)
{
	return Object.assign(
		{
			Probe: { RAMMB: { Total: 16384, Free: 8192 }, GPU: { Present: false, VRAMMB: null }, DiskFreeMB: 100000 },
			Env: {},
			FileExists: () => false,
			CommandExists: () => false
		}, pOver || {});
}

suite('CapabilityReadiness.evaluate -- the advertise gate (V51 F155, WI-513)', () =>
{
	test('no Resources (or an empty one) is always ready -- pre-513 packages advertise unchanged', () =>
	{
		Expect(libReadiness.evaluate(null, ctx()).Ready).to.equal(true);
		Expect(libReadiness.evaluate({}, ctx()).Ready).to.equal(true);
		Expect(libReadiness.evaluate(undefined, ctx()).Ready).to.equal(true);
	});

	test('hardware thresholds: met passes, unmet fails and names the gap', () =>
	{
		Expect(libReadiness.evaluate({ Hardware: { MinRAMMB: 8192 } }, ctx()).Ready).to.equal(true);
		let tmpResult = libReadiness.evaluate({ Hardware: { MinRAMMB: 32768 } }, ctx());
		Expect(tmpResult.Ready).to.equal(false);
		Expect(tmpResult.Unmet[0]).to.contain('RAM');
		Expect(tmpResult.Unmet[0]).to.contain('16384 MB present');
	});

	test('a GPU requirement fails on a GPU-less box, passes when present with enough VRAM', () =>
	{
		Expect(libReadiness.evaluate({ Hardware: { GPU: true } }, ctx()).Ready).to.equal(false);
		let tmpGood = ctx({ Probe: { RAMMB: { Total: 16384 }, GPU: { Present: true, VRAMMB: 24576 }, DiskFreeMB: 100000 } });
		Expect(libReadiness.evaluate({ Hardware: { GPU: true, MinVRAMMB: 16384 } }, tmpGood).Ready).to.equal(true);
		Expect(libReadiness.evaluate({ Hardware: { GPU: true, MinVRAMMB: 49152 } }, tmpGood).Ready).to.equal(false);
	});

	test('an unmeasured hardware field (null) does NOT satisfy a declared threshold', () =>
	{
		let tmpNull = ctx({ Probe: { RAMMB: { Total: null }, GPU: { Present: false, VRAMMB: null }, DiskFreeMB: null } });
		Expect(libReadiness.evaluate({ Hardware: { MinRAMMB: 1 } }, tmpNull).Ready).to.equal(false);
		Expect(libReadiness.evaluate({ Hardware: { MinDiskMB: 1 } }, tmpNull).Ready).to.equal(false);
	});

	test('sql-connection defaults to the PLANSHEET_QUERY_DB_URL env var', () =>
	{
		Expect(libReadiness.evaluate({ Requires: [ { Kind: 'sql-connection' } ] }, ctx()).Ready).to.equal(false);
		Expect(libReadiness.evaluate({ Requires: [ { Kind: 'sql-connection' } ] }, ctx({ Env: { PLANSHEET_QUERY_DB_URL: 'postgres://x' } })).Ready).to.equal(true);
	});

	test('a model requirement checks a Command on PATH', () =>
	{
		let tmpHas = ctx({ CommandExists: (pCmd) => pCmd === 'claude' });
		Expect(libReadiness.evaluate({ Requires: [ { Kind: 'model', Command: 'claude' } ] }, tmpHas).Ready).to.equal(true);
		Expect(libReadiness.evaluate({ Requires: [ { Kind: 'model', Command: 'claude' } ] }, ctx()).Ready).to.equal(false);
	});

	test('a content-sync requirement checks a local mirror Path exists', () =>
	{
		let tmpHas = ctx({ FileExists: (pPath) => pPath === '/mirror/docs' });
		Expect(libReadiness.evaluate({ Requires: [ { Kind: 'content-sync', Path: '/mirror/docs' } ] }, tmpHas).Ready).to.equal(true);
		Expect(libReadiness.evaluate({ Requires: [ { Kind: 'content-sync', Path: '/mirror/docs' } ] }, ctx()).Ready).to.equal(false);
	});

	test('a requirement with no checkable condition fails CLOSED', () =>
	{
		let tmpResult = libReadiness.evaluate({ Requires: [ { Kind: 'model' } ] }, ctx());
		Expect(tmpResult.Ready).to.equal(false);
		Expect(tmpResult.Unmet[0]).to.contain('no checkable condition');
	});

	test('all unmet reasons accumulate across hardware and requires', () =>
	{
		let tmpResult = libReadiness.evaluate(
			{ Hardware: { MinRAMMB: 9999999 }, Requires: [ { Kind: 'sql-connection' }, { Kind: 'model', Command: 'claude' } ] }, ctx());
		Expect(tmpResult.Ready).to.equal(false);
		Expect(tmpResult.Unmet.length).to.equal(3);
	});
});
