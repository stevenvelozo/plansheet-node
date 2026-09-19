'use strict';

/**
 * ClientConfig -- where the node client keeps its per-node connection files on the user's machine.
 *
 * Layout (mode 0700 dir, 0600 files):
 *   ~/.plansheet/nodes/<slug>.json   one file per provisioned node
 *
 * A node file is the runner's whole identity: the plansheet URL, the hub URL, the node's own pls_ token (its hub
 * join secret), and the derived BeaconName. The user's own account token is deliberately NOT persisted -- the
 * login flow mints it, uses it to provision/approve, and discards it, so a stolen node file yields only a
 * narrowed, revocable node credential, never the user's full-authority token.
 *
 * The directory honors PLANSHEET_HOME (then falls back to ~/.plansheet) so a dockerized runner can mount it.
 *
 * @author Steven Velozo <steven@velozo.com>
 * @license MIT
 */

const libFS = require('fs');
const libOS = require('os');
const libPath = require('path');

class ClientConfig
{
	constructor(pConfig)
	{
		let tmpConfig = pConfig || {};
		this._Home = tmpConfig.Home || process.env.PLANSHEET_HOME || libPath.join(libOS.homedir(), '.plansheet');
		this._NodesDir = libPath.join(this._Home, 'nodes');
	}

	get home() { return this._Home; }
	get nodesDir() { return this._NodesDir; }

	// A filesystem-safe slug for a node name ('Matchbook-001' -> 'matchbook-001').
	static slug(pName)
	{
		return String(pName || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'node';
	}

	_ensureDirs()
	{
		if (!libFS.existsSync(this._Home)) { libFS.mkdirSync(this._Home, { recursive: true, mode: 0o700 }); }
		if (!libFS.existsSync(this._NodesDir)) { libFS.mkdirSync(this._NodesDir, { recursive: true, mode: 0o700 }); }
		// Tighten in case an older umask left them loose (best-effort; ignored on platforms without chmod).
		try { libFS.chmodSync(this._Home, 0o700); } catch (pIgnore) { /* best-effort */ }
		try { libFS.chmodSync(this._NodesDir, 0o700); } catch (pIgnore) { /* best-effort */ }
	}

	pathForSlug(pSlug)
	{
		return libPath.join(this._NodesDir, ClientConfig.slug(pSlug) + '.json');
	}

	// Persist a node record. Required: NodeName, NodeKey, NodeToken, PlansheetURL, HubURL, IDNodeRegistration.
	saveNode(pRecord)
	{
		let tmpRecord = pRecord || {};
		if (!tmpRecord.NodeName) { throw new Error('ClientConfig.saveNode: NodeName is required.'); }
		if (!tmpRecord.NodeToken) { throw new Error('ClientConfig.saveNode: NodeToken is required.'); }
		this._ensureDirs();
		let tmpSlug = ClientConfig.slug(tmpRecord.NodeName);
		let tmpPath = this.pathForSlug(tmpSlug);
		let tmpToWrite = Object.assign({ Slug: tmpSlug, SavedAt: new Date().toISOString() }, tmpRecord);
		// Write 0600 up front so the token is never briefly world-readable.
		libFS.writeFileSync(tmpPath, JSON.stringify(tmpToWrite, null, '\t') + '\n', { mode: 0o600 });
		try { libFS.chmodSync(tmpPath, 0o600); } catch (pIgnore) { /* best-effort */ }
		return tmpPath;
	}

	loadNode(pSlugOrName)
	{
		let tmpPath = this.pathForSlug(pSlugOrName);
		if (!libFS.existsSync(tmpPath)) { return null; }
		try { return JSON.parse(libFS.readFileSync(tmpPath, 'utf8')); }
		catch (pError) { throw new Error('Could not read node config ' + tmpPath + ' (' + pError.message + ').'); }
	}

	// Every saved node record, newest first. Unreadable files are skipped, not fatal.
	listNodes()
	{
		if (!libFS.existsSync(this._NodesDir)) { return []; }
		let tmpOut = [];
		let tmpFiles = libFS.readdirSync(this._NodesDir).filter((pName) => pName.endsWith('.json'));
		for (let i = 0; i < tmpFiles.length; i++)
		{
			try { tmpOut.push(JSON.parse(libFS.readFileSync(libPath.join(this._NodesDir, tmpFiles[i]), 'utf8'))); }
			catch (pIgnore) { /* skip a corrupt file rather than fail the whole listing */ }
		}
		tmpOut.sort((pA, pB) => String(pB.SavedAt || '').localeCompare(String(pA.SavedAt || '')));
		return tmpOut;
	}

	removeNode(pSlugOrName)
	{
		let tmpPath = this.pathForSlug(pSlugOrName);
		if (!libFS.existsSync(tmpPath)) { return false; }
		libFS.unlinkSync(tmpPath);
		return true;
	}
}

module.exports = ClientConfig;
