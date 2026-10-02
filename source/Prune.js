'use strict';

/**
 * Prune: the pure selection + classification logic behind `plansheet-node prune` (the "docker prune" for saved
 * node configs on this machine).
 *
 * Kept free of file IO and the network so it can be reasoned about and tested directly: the bin does the reads
 * (listNodes), the probes (PlansheetClient), and the removes (removeNode); this just decides WHICH saved nodes a
 * given selection covers and WHETHER a liveness probe means the node should be pruned.
 *
 * The governing rule is "prune only what the server has actually forgotten." A node that is merely offline right
 * now (a transport failure) or whose server answered with a 5xx is KEPT -- pruning on a transient failure would
 * throw away a live node's only local token. Only a definitive "I do not know this node" (401 / 403 / 404), which
 * is what a dev rebuild, a revoked token, or a retired registration produces, removes the local config.
 *
 * @author Steven Velozo <steven@velozo.com>
 * @license MIT
 */

// Normalize a plansheet URL for comparison: trim and drop trailing slashes, matching how PlansheetClient stores
// its BaseURL. So '--url https://dev.plansheet.io/' matches a node saved as 'https://dev.plansheet.io'.
function normalizeURL(pURL)
{
	return String(pURL === null || typeof pURL === 'undefined' ? '' : pURL).trim().replace(/\/+$/, '');
}

// The saved nodes a prune covers: all of them, or just those for one plansheet URL when --url is given.
function selectNodes(pNodes, pURL)
{
	let tmpNodes = Array.isArray(pNodes) ? pNodes : [];
	let tmpWanted = normalizeURL(pURL);
	if (!tmpWanted) { return tmpNodes.slice(); }
	return tmpNodes.filter((pNode) => normalizeURL(pNode && pNode.PlansheetURL) === tmpWanted);
}

// Turn one node's liveness probe into a verdict. pProbe is either { Reachable: true, StatusCode } for an HTTP
// response, or { Reachable: false } for a transport failure (server down, DNS, timeout). Returns
// { State: 'alive' | 'dead' | 'error' | 'unreachable', Remove: boolean }.
function classifyProbe(pProbe)
{
	if (!pProbe || pProbe.Reachable === false) { return { State: 'unreachable', Remove: false }; }
	let tmpCode = Number(pProbe.StatusCode) || 0;
	if (tmpCode >= 200 && tmpCode < 300) { return { State: 'alive', Remove: false }; }
	// The server knows the route but refuses or cannot find this node: its registration/token is gone.
	if (tmpCode === 401 || tmpCode === 403 || tmpCode === 404) { return { State: 'dead', Remove: true }; }
	// 5xx or anything unexpected: the server is unhappy, not authoritative about this node. Keep it.
	return { State: 'error', Remove: false };
}

module.exports = { normalizeURL, selectNodes, classifyProbe };
