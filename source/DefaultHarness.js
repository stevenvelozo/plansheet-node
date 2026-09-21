'use strict';

/**
 * DefaultHarness -- the built-in stub a node runs when no --harness config is supplied.
 *
 * It advertises plansheet.software / RunWorkItem (exactly what plansheet dispatches) and, for each work item,
 * just logs the item and exits 0. That is enough to prove the whole loop end to end: login a node, run it,
 * dispatch a work item, watch it succeed through the secured hub. Replace it with a real --harness config (or,
 * later, harness config pulled from the plansheet UI) to make the node do real work.
 *
 * @author Steven Velozo <steven@velozo.com>
 * @license MIT
 */

function defaultHarnessConfig()
{
	return {
		Capability: 'plansheet.software',
		MaxOutputBytes: 65536,
		Actions:
		{
			RunWorkItem:
			{
				Description: 'Default stub: log the dispatched work item and succeed.',
				Command: '/bin/sh',
				Args: [ '-c', 'echo "[plansheet-node] work item #$PLANSHEET_WORKITEM_NUMBER (id $PLANSHEET_IDWORKITEM): $PLANSHEET_WORKITEM_TITLE"; echo "staging=$PLANSHEET_STAGING"; exit 0' ]
			}
		}
	};
}

module.exports = defaultHarnessConfig;
