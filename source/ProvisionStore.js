'use strict';

/**
 * ProvisionStore -- materialize a capability package's implementation onto the node.
 *
 * A capability package manifest may carry a `Provision` block: the implementation the package's Actions run,
 * shipped WITH the manifest from plansheet so a node pulls the CODE the same way it pulls the capability. No
 * second install, no separate package -- the catalog entry is self-contained. This writes those files to a
 * per-package directory under the node home and returns it; the harness runs the Action Command from there (its
 * Cwd default, plus PLANSHEET_PROVISION_DIR and the {Provision} placeholder).
 *
 * Layout:  <home>/provision/<package-slug>-<version>/
 *
 * Idempotent + version-keyed: a directory whose marker matches the package key, version AND a content hash of the
 * files is reused as-is; a version bump or an edited payload re-materializes (wipe + rewrite). A node therefore
 * provisions once per package version and reuses it across restarts.
 *
 * Provision := { Files: [ { Path (relative, no '..'), Content (string), Mode? ('0755') } ] }.
 * Trust: a package comes from the plan sheet's admin-curated catalog -- the same trust boundary that already
 * lets the manifest name the Command the node runs -- so shipping the implementation this way widens nothing.
 *
 * @author Steven Velozo <steven@velozo.com>
 * @license MIT
 */

const libFS = require('fs');
const libPath = require('path');
const libCrypto = require('crypto');

const _MARKER = '.plansheet-provisioned.json';

function _slug(pValue)
{
	return String(pValue || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'package';
}

// A package file path must be RELATIVE and stay inside the package dir. Returns a normalized relative path, or
// null if it is absolute, escapes with '..', or contains a null byte -- a package is semi-trusted catalog content,
// so it must never write outside the directory provisioned for it.
function _safeRelative(pPath)
{
	let tmpPath = String(pPath || '').replace(/\\/g, '/');
	if (!tmpPath || tmpPath.charAt(0) === '/' || tmpPath.indexOf('\0') >= 0) { return null; }
	let tmpNorm = libPath.normalize(tmpPath);
	if (tmpNorm === '..' || tmpNorm.indexOf('../') === 0 || tmpNorm.indexOf('/../') >= 0 || libPath.isAbsolute(tmpNorm)) { return null; }
	return tmpNorm;
}

function _parseMode(pMode)
{
	if (pMode === undefined || pMode === null || pMode === '') { return null; }
	if (typeof pMode === 'number') { return pMode; }
	let tmpParsed = parseInt(String(pMode), 8);
	return Number.isFinite(tmpParsed) ? tmpParsed : null;
}

class ProvisionStore
{
	constructor(pConfig)
	{
		let tmpConfig = pConfig || {};
		this._Dir = libPath.join(tmpConfig.Home || process.cwd(), 'provision');
		this._Log = tmpConfig.Log || console;
	}

	// Materialize pProvision for (pKey, pVersion); returns the absolute dir the files live in, or '' if there is
	// nothing to provision. Throws only on a malformed file path (a package trying to escape its directory).
	materialize(pKey, pVersion, pProvision)
	{
		if (!pProvision || typeof pProvision !== 'object' || !Array.isArray(pProvision.Files) || !pProvision.Files.length) { return ''; }

		let tmpKey = _slug(pKey);
		let tmpVersion = _slug(String(pVersion === undefined || pVersion === null ? '0' : pVersion)) || '0';
		let tmpDir = libPath.join(this._Dir, tmpKey + '-' + tmpVersion);
		let tmpHash = libCrypto.createHash('sha256').update(JSON.stringify(pProvision.Files)).digest('hex');
		let tmpMarkerPath = libPath.join(tmpDir, _MARKER);

		// Up to date? Reuse as-is (the common path on every restart).
		try
		{
			let tmpMarker = JSON.parse(libFS.readFileSync(tmpMarkerPath, 'utf8'));
			if (tmpMarker && tmpMarker.Hash === tmpHash) { return tmpDir; }
		}
		catch (pIgnore) { /* no / stale marker -> (re)materialize */ }

		// (Re)materialize: wipe the dir so a shrunk payload leaves no stale files, then write every file.
		try { libFS.rmSync(tmpDir, { recursive: true, force: true }); } catch (pIgnore) { /* fresh */ }
		libFS.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });

		for (let i = 0; i < pProvision.Files.length; i++)
		{
			let tmpFile = pProvision.Files[i] || {};
			let tmpRel = _safeRelative(tmpFile.Path);
			if (!tmpRel) { throw new Error('ProvisionStore: unsafe file path in package [' + tmpKey + ']: ' + JSON.stringify(tmpFile.Path)); }
			let tmpAbs = libPath.join(tmpDir, tmpRel);
			libFS.mkdirSync(libPath.dirname(tmpAbs), { recursive: true, mode: 0o700 });
			libFS.writeFileSync(tmpAbs, String(tmpFile.Content === undefined || tmpFile.Content === null ? '' : tmpFile.Content));
			let tmpMode = _parseMode(tmpFile.Mode);
			if (tmpMode !== null) { try { libFS.chmodSync(tmpAbs, tmpMode); } catch (pIgnore) { /* best-effort */ } }
		}

		libFS.writeFileSync(tmpMarkerPath, JSON.stringify({ Key: tmpKey, Version: tmpVersion, Hash: tmpHash, ProvisionedAt: new Date().toISOString() }, null, '\t') + '\n');
		(this._Log.info || this._Log.log || console.log)('[plansheet-node]   provisioned ' + pProvision.Files.length + ' file(s) for package [' + tmpKey + '] v' + tmpVersion + ' -> ' + tmpDir);
		return tmpDir;
	}
}

module.exports = ProvisionStore;
