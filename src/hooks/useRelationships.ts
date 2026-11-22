import { useEffect, useState } from 'react';
import * as Y from 'yjs';
import { getRootDoc } from '@/services/store/docs.ts';
import { listPeople } from '@/services/store/people.ts';
import { listRelationships } from '@/services/store/relationships.ts';
import { listChannelDescriptors } from '@/services/store/channelRegistry.ts';
import type { ChannelDescriptor, Person, Relationship } from '@/types.ts';

interface RelationshipCatalogSnapshot {
  people: Person[];
  relationships: Relationship[];
  channels: ChannelDescriptor[];
}

export function useRelationshipCatalog(): RelationshipCatalogSnapshot {
  const [snapshot, setSnapshot] = useState<RelationshipCatalogSnapshot>(() => ({
    people: listPeople(),
    relationships: listRelationships(),
    channels: listChannelDescriptors(),
  }));

  useEffect(() => {
    const doc = getRootDoc();
    const people = doc.getMap<Y.Map<unknown>>('people');
    const relationships = doc.getMap<Y.Map<unknown>>('relationships');
    const channels = doc.getMap<Y.Map<unknown>>('channelDescriptors');
    const refresh = () => setSnapshot({
      people: listPeople(doc),
      relationships: listRelationships(doc),
      channels: listChannelDescriptors(doc),
    });

    refresh();
    people.observeDeep(refresh);
    relationships.observeDeep(refresh);
    channels.observeDeep(refresh);
    return () => {
      people.unobserveDeep(refresh);
      relationships.unobserveDeep(refresh);
      channels.unobserveDeep(refresh);
    };
  }, []);

  return snapshot;
}
