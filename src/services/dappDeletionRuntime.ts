import { queueRemoteChannelPurge } from './browserRelationshipRuntime.ts';
import { destroyDappRelationshipChannels } from './sharingRuntime.ts';
import { removeDappCatalogEntry } from './store/config.ts';
import { compactRootPersistence, getRootDoc, purgeDappLocalResources } from './store/docs.ts';
import {
  listChannelDescriptorsForDapp,
  removeChannelDescriptorsForDapp,
} from './store/channelRegistry.ts';
import { removeDirectBindingsForDapp } from './store/directBindings.ts';
import { removeChannelSharesForDapp } from './store/channelShares.ts';

interface DappDeletionResult {
  remotePurgeRequests: number;
  remotePurgeRequestFailures: string[];
}

/**
 * Deletes a Dapp locally without waiting for peers. Signed remote channel-purge
 * requests are queued first and remain in the root document until acknowledged.
 */
export async function deleteDapp(dappId: string): Promise<DappDeletionResult> {
  const rootDoc = getRootDoc();
  const descriptors = listChannelDescriptorsForDapp(dappId, rootDoc);
  const remotePurgeRequestFailures: string[] = [];
  let remotePurgeRequests = 0;

  for (const descriptor of descriptors) {
    try {
      await queueRemoteChannelPurge(descriptor, 'dapp-deleted');
      remotePurgeRequests += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      remotePurgeRequestFailures.push(`${descriptor.id}: ${message}`);
    }
  }

  // Local erasure never waits for peer acknowledgement.
  await destroyDappRelationshipChannels(dappId, true);
  await purgeDappLocalResources(dappId);

  rootDoc.transact(() => {
    removeDirectBindingsForDapp(dappId, rootDoc);
    removeChannelSharesForDapp(dappId, rootDoc);
    removeChannelDescriptorsForDapp(dappId, rootDoc);
    removeDappCatalogEntry(dappId);
  }, 'dapp-local-purge');

  // Compact away historical catalog/descriptor updates containing deleted credentials.
  await compactRootPersistence();

  return { remotePurgeRequests, remotePurgeRequestFailures };
}
