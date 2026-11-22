import { useParams } from 'react-router-dom';
import CodeAppEditor from '@/components/code-app/CodeAppEditor';

export default function CodeAppEditorPage() {
  const { id } = useParams<{ id: string }>();
  if (!id) return null;

  return (
    <div className="mx-auto flex h-full w-full max-w-7xl flex-col px-4 py-4 sm:px-6 sm:py-5">
      <CodeAppEditor dappId={id} />
    </div>
  );
}
