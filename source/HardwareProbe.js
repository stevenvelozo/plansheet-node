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

// Apple Silicon has an integrated Metal GPU that shares the unified memory -- no separate VRAM to query, and
// nvidia-smi does not exist. When the nvidia path finds nothing on a darwin/arm64 box, report the chip as a GPU whose
// "VRAM" is the share of unified memory Metal can use (macOS lets it use roughly three quarters by default), so the
// readiness gate can tell whether a local model fits. Returns null off Apple Silicon (the caller then reports no GPU).
function _appleSiliconGPU()
{
	try
	{
		if (process.platform !== 'darwin' || process.arch !== 'arm64') { return null; }
		let tmpChip = 'Apple Silicon';
		try
		{
			let tmpBrand = libChildProcess.execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string'],
				{ encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
			tmpChip = String(tmpBrand || '').trim() || 'Apple Silicon';
		}
		catch (pIgnore) { /* keep the generic name */ }
		let tmpTotal = libOS.totalmem() / _BYTES_PER_MB;
		let tmpUsableMB = (isFinite(tmpTotal) && tmpTotal > 0) ? Math.round(tmpTotal * 0.75) : null;
		return { Present: true, VRAMMB: tmpUsableMB, Cards: [ { Name: tmpChip + ' (unified memory)', VRAMMB: tmpUsableMB } ] };
	}
	catch (pError) { return null; }
}

// GPU via nvidia-smi: each card's NAME and VRAM, so the server can scope which models a box can run (Steven,
// 2026-10-01) -- not just a pooled number. Returns { Present, VRAMMB (total across cards, for a pooled MinVRAMMB
// threshold), Cards: [{ Name, VRAMMB }] }. No nvidia-smi falls back to Apple Silicon detection (_appleSiliconGPU);
// off both it is { Present: false, VRAMMB: null, Cards: [] }. A short timeout keeps a wedged driver from stalling startup.
function _gpu()
{
	try
	{
		let tmpOutput = libChildProcess.execFileSync('nvidia-smi',
			['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
			{ encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
		let tmpLines = String(tmpOutput || '').split('\n').map((pLine) => pLine.trim()).filter((pLine) => pLine);
		if (!tmpLines.length) { return _appleSiliconGPU() || { Present: false, VRAMMB: null, Cards: [] }; }
		let tmpCards = [];
		let tmpTotal = 0;
		let tmpAnyNumber = false;
		tmpLines.forEach((pLine) =>
		{
			// Each line is "name, memory.total". Split on the LAST comma so a card name containing a comma survives.
			let tmpComma = pLine.lastIndexOf(',');
			let tmpName = ((tmpComma >= 0) ? pLine.slice(0, tmpComma) : pLine).trim();
			let tmpVRAMRaw = (tmpComma >= 0) ? pLine.slice(tmpComma + 1) : '';
			let tmpValue = Number(String(tmpVRAMRaw).replace(/[^0-9.]/g, ''));
			let tmpCardVRAM = (isFinite(tmpValue) && tmpValue > 0) ? Math.round(tmpValue) : null;
			if (tmpCardVRAM !== null) { tmpTotal += tmpCardVRAM; tmpAnyNumber = true; }
			tmpCards.push({ Name: tmpName || '(unknown GPU)', VRAMMB: tmpCardVRAM });
		});
		return { Present: true, VRAMMB: tmpAnyNumber ? Math.round(tmpTotal) : null, Cards: tmpCards };
	}
	catch (pError) { return _appleSiliconGPU() || { Present: false, VRAMMB: null, Cards: [] }; }
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
