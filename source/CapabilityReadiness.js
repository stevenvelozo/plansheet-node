'use strict';

/**
 * CapabilityReadiness: decide whether this node may ADVERTISE a capability, given the package's declared
 * Resources, the node's probed hardware, and its environment / filesystem (V51 F155, WI-513).
 *
 * This is the "readiness" half of the manifest Resources concept. A capability package declares what the box
 * needs; a node advertises the capability -- and so becomes an F153 activation candidate -- ONLY when every
 * declared requirement is met. A weak box never offers a 72b model; a box with no read-only connection never
 * offers the SQL capability. The gate runs on the node so the box itself is the source of truth about its own
 * hardware and configuration; the server only stores and displays what the node reports.
 *
 * Pure and side-effect free: the probe, the environment, and the filesystem / PATH checks are all passed in
 * through pContext, so the whole gate is unit-tested without touching real hardware. A package with no Resources
 * block is always ready (every package shipped before this existed keeps advertising unchanged).
 *
 * Resources shape (inside the package manifest):
 *   { Hardware?: { MinRAMMB?, GPU?: bool, MinVRAMMB?, MinDiskMB? },
 *     Requires?: [ { Kind: 'model' | 'sql-connection' | 'content-sync', EnvVar?, Command?, Path?, Label? } ] }
 *
 * pContext:
 *   { Probe: { RAMMB: { Total, Free }, GPU: { Present, VRAMMB }, DiskFreeMB },
 *     Env: process.env, FileExists: (path) => bool, CommandExists: (cmd) => bool }
 *
 * @author Steven Velozo <steven@velozo.com>
 * @license MIT
 */

function _num(pValue)
{
	let tmpNumber = Number(pValue);
	return (typeof tmpNumber === 'number' && isFinite(tmpNumber)) ? tmpNumber : null;
}

// Evaluate the Hardware block against the probe. Each threshold is optional; a declared one the probe cannot
// satisfy (or cannot measure) adds an Unmet reason. A probe field that is null means "could not measure", which
// is treated as NOT meeting a declared threshold -- a box that cannot prove it has the VRAM does not advertise.
function _checkHardware(pHardware, pProbe, pUnmet)
{
	let tmpHardware = pHardware || {};
	let tmpProbe = pProbe || {};
	let tmpRAM = (tmpProbe.RAMMB && _num(tmpProbe.RAMMB.Total));
	let tmpVRAM = (tmpProbe.GPU && _num(tmpProbe.GPU.VRAMMB));
	let tmpDisk = _num(tmpProbe.DiskFreeMB);
	let tmpGPUPresent = !!(tmpProbe.GPU && tmpProbe.GPU.Present);

	let tmpMinRAM = _num(tmpHardware.MinRAMMB);
	if (tmpMinRAM !== null && !(tmpRAM !== null && tmpRAM >= tmpMinRAM))
	{
		pUnmet.push('needs ' + tmpMinRAM + ' MB RAM' + (tmpRAM === null ? ' (RAM not measured)' : ' (' + tmpRAM + ' MB present)'));
	}
	if (tmpHardware.GPU === true && !tmpGPUPresent)
	{
		pUnmet.push('needs a GPU (none detected)');
	}
	let tmpMinVRAM = _num(tmpHardware.MinVRAMMB);
	if (tmpMinVRAM !== null && !(tmpVRAM !== null && tmpVRAM >= tmpMinVRAM))
	{
		pUnmet.push('needs ' + tmpMinVRAM + ' MB VRAM' + (tmpVRAM === null ? ' (VRAM not measured)' : ' (' + tmpVRAM + ' MB present)'));
	}
	let tmpMinDisk = _num(tmpHardware.MinDiskMB);
	if (tmpMinDisk !== null && !(tmpDisk !== null && tmpDisk >= tmpMinDisk))
	{
		pUnmet.push('needs ' + tmpMinDisk + ' MB free disk' + (tmpDisk === null ? ' (disk not measured)' : ' (' + tmpDisk + ' MB free)'));
	}
}

// Evaluate one Requires entry. A requirement declares HOW to check it: an EnvVar that must be set non-empty, a
// Command that must be on PATH, or a Path that must exist. Whichever of those keys are present must all pass.
// Kind only shapes the default (a sql-connection defaults to the PLANSHEET_QUERY_DB_URL env var) and the label.
function _checkRequire(pRequire, pContext, pUnmet)
{
	let tmpRequire = pRequire || {};
	let tmpKind = String(tmpRequire.Kind || '').trim();
	let tmpLabel = String(tmpRequire.Label || '').trim() || (tmpKind || 'requirement');
	let tmpEnv = pContext.Env || {};
	let tmpFileExists = (typeof pContext.FileExists === 'function') ? pContext.FileExists : (() => false);
	let tmpCommandExists = (typeof pContext.CommandExists === 'function') ? pContext.CommandExists : (() => false);

	// A sql-connection with no explicit check defaults to the connection env var the RunSQL action reads.
	let tmpEnvVar = String(tmpRequire.EnvVar || '').trim();
	if (!tmpEnvVar && !tmpRequire.Command && !tmpRequire.Path && tmpKind === 'sql-connection') { tmpEnvVar = 'PLANSHEET_QUERY_DB_URL'; }

	let tmpChecked = false;
	if (tmpEnvVar)
	{
		tmpChecked = true;
		if (!String(tmpEnv[tmpEnvVar] || '').trim()) { pUnmet.push(tmpLabel + ': env ' + tmpEnvVar + ' is not set'); }
	}
	let tmpCommand = String(tmpRequire.Command || '').trim();
	if (tmpCommand)
	{
		tmpChecked = true;
		if (!tmpCommandExists(tmpCommand)) { pUnmet.push(tmpLabel + ': command "' + tmpCommand + '" is not on PATH'); }
	}
	let tmpPath = String(tmpRequire.Path || '').trim();
	if (tmpPath)
	{
		tmpChecked = true;
		if (!tmpFileExists(tmpPath)) { pUnmet.push(tmpLabel + ': path "' + tmpPath + '" does not exist'); }
	}

	// A requirement that declared no checkable condition is a spec error on the package author's side. Fail
	// closed and say so, rather than silently advertising something whose prerequisite was never verified.
	if (!tmpChecked)
	{
		pUnmet.push(tmpLabel + ': no checkable condition declared (needs EnvVar, Command, or Path)');
	}
}

// Decide readiness. Returns { Ready, Unmet: [human reasons] }. No Resources (or an empty one) is always ready.
function evaluate(pResources, pContext)
{
	let tmpContext = pContext || {};
	let tmpUnmet = [];
	if (pResources && typeof pResources === 'object' && !Array.isArray(pResources))
	{
		_checkHardware(pResources.Hardware, tmpContext.Probe, tmpUnmet);
		let tmpRequires = Array.isArray(pResources.Requires) ? pResources.Requires : [];
		tmpRequires.forEach((pRequire) => _checkRequire(pRequire, tmpContext, tmpUnmet));
	}
	return { Ready: (tmpUnmet.length === 0), Unmet: tmpUnmet };
}

module.exports = { evaluate: evaluate };
