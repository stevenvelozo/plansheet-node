'use strict';

/**
 * NodeIdentity -- generates the two names a node needs.
 *
 * NodeName  is human-facing (shown in the plansheet UI, used as the agent persona name at Provision). The default
 *           is a friendly word plus a zero-padded ordinal, e.g. 'Matchbook-001'. The word is stable per machine
 *           (derived from the hostname) so a second runner on the same box reads as 'Matchbook-002'; the user can
 *           always type their own at the prompt.
 * NodeKey   is the machine identity slug the node self-registers; the server derives BeaconName = ps.<IDCustomer>.<NodeKey>
 *           from it. Format 'nk-<hostslug>-<random>', minted once and never reused.
 *
 * @author Steven Velozo <steven@velozo.com>
 * @license MIT
 */

const libOS = require('os');
const libCrypto = require('crypto');

// Tangible, unambiguous objects -- easy to say aloud, no collisions with plansheet nouns.
const NAME_WORDS =
[
	'Matchbook', 'Lantern', 'Compass', 'Anvil', 'Kettle', 'Satchel', 'Thimble', 'Domino',
	'Harbor', 'Beacon', 'Ledger', 'Piston', 'Willow', 'Cobalt', 'Marble', 'Falcon',
	'Cinder', 'Pewter', 'Quartz', 'Rudder', 'Tamarind', 'Vellum', 'Walnut', 'Zephyr'
];

// A small stable hash of a string -> non-negative integer (djb2). Deterministic across runs, no crypto needed.
function stableHash(pText)
{
	let tmpHash = 5381;
	let tmpText = String(pText || '');
	for (let i = 0; i < tmpText.length; i++) { tmpHash = ((tmpHash * 33) ^ tmpText.charCodeAt(i)) >>> 0; }
	return tmpHash;
}

function hostSlug(pHost)
{
	let tmpHost = String((pHost !== undefined && pHost !== null) ? pHost : libOS.hostname() || 'host');
	// Just the short hostname (drop domain), filesystem/URL safe.
	return (tmpHost.split('.')[0] || 'host').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'host';
}

// Pick a stable word for a seed (defaults to the machine hostname).
function pickWord(pSeed)
{
	let tmpSeed = (pSeed !== undefined && pSeed !== null) ? pSeed : libOS.hostname();
	return NAME_WORDS[stableHash(tmpSeed) % NAME_WORDS.length];
}

// Default node name: '<Word>-<NNN>'. pOptions: { Ordinal (default 1), Seed (default hostname) }.
function generateNodeName(pOptions)
{
	let tmpOptions = pOptions || {};
	let tmpOrdinal = Number(tmpOptions.Ordinal);
	if (!(tmpOrdinal >= 1)) { tmpOrdinal = 1; }
	let tmpWord = pickWord(tmpOptions.Seed);
	return tmpWord + '-' + String(tmpOrdinal).padStart(3, '0');
}

// A fresh, unique-enough machine key: 'nk-<hostslug>-<8 hex>'.
function generateNodeKey(pHost)
{
	return 'nk-' + hostSlug(pHost) + '-' + libCrypto.randomBytes(4).toString('hex');
}

module.exports = { generateNodeName, generateNodeKey, pickWord, hostSlug, stableHash, NAME_WORDS };
