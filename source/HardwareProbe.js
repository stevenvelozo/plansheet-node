'use strict';

/**
 * HardwareProbe: measure the box this node runs on -- RAM, GPU presence + VRAM, free disk (V51 F155, WI-513).
 *
 * Best-effort and non-throwing: every measurement is wrapped so a box with no GPU, an old Node without
 * statfsSync, or a missing nvidia-smi yields a null/false for that field rather than an error. A field that
 * could not be measured reads as null, and CapabilityReadiness treats a declared threshold against a null as
 * NOT met -- a node that cannot prove it has the VRAM does not advertise a model that needs it.
 *
 * All sizes are MB. The probe is read once at startup and reported to plansheet alongside the advertised
 * capabilities (the F153 Self/Register path), so the Nodes screen can show what each box is and the readiness
 * gate can keep a weak box out of the activation list.
 *
 * @author Steven Velozo <steven@velozo.com>
 * @license MIT
 */

const libOS = require('os');
const libFS = require('fs');
const libChildProcess = require('child_process');

const _BYTES_PER_MB = 1024 * 1024;

function _ramMB()
{
	try { return { Total: Math.round(libOS.totalmem() / _BYTES_PER_MB), Free: Math.round(libOS.freemem() / _BYTES_PER_MB) }; }
	catch (pError) { return { Total: null, Free: null }; }
}

// GPU via nvidia-smi: total VRAM in MB, summed across devices. No nvidia-smi (the common case on a laptop or a
// SQL-only box) -> { Present: false, VRAMMB: null }. A short timeout keeps a wedged driver from stalling startup.
function _gpu()
{
	try
	{
		let tmpOutput = libChildProcess.execFileSync('nvidia-smi',
			['--query-gpu=memory.total', '--format=csv,noheader,nounits'],
			{ encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
		let tmpLines = String(tmpOutput || '').split('\n').map((pLine) => pLine.trim()).filter((pLine) => pLine);
		if (!tmpLines.length) { return { Present: false, VRAMMB: null }; }
		let tmpTotal = 0;
		let tmpAnyNumber = false;
		tmpLines.forEach((pLine) =>
		{
			let tmpValue = Number(String(pLine).replace(/[^0-9.]/g, ''));
			if (isFinite(tmpValue) && tmpValue > 0) { tmpTotal += tmpValue; tmpAnyNumber = true; }
		});
		return { Present: true, VRAMMB: tmpAnyNumber ? Math.round(tmpTotal) : null };
	}
	catch (pError) { return { Present: false, VRAMMB: null }; }
}

// Free disk on pPath (default the current working directory, where a model or a content mirror would land).
// Uses fs.statfsSync (Node 18.15+); older Node or a bad path -> null.
function _diskFreeMB(pPath)
{
	try
	{
		if (typeof libFS.statfsSync !== 'function') { return null; }
		let tmpStats = libFS.statfsSync(pPath || process.cwd());
		let tmpFreeBytes = Number(tmpStats.bavail) * Number(tmpStats.bsize);
		return isFinite(tmpFreeBytes) ? Math.round(tmpFreeBytes / _BYTES_PER_MB) : null;
	}
	catch (pError) { return null; }
}

// Probe the box. pOptions.DiskPath picks which filesystem to measure free space on (default cwd).
function probe(pOptions)
{
	let tmpOptions = pOptions || {};
	return {
		RAMMB: _ramMB(),
		GPU: _gpu(),
		DiskFreeMB: _diskFreeMB(tmpOptions.DiskPath)
	};
}

module.exports = { probe: probe };
