'use client';

import { useState, type ReactElement, type ReactNode } from 'react';

import { Button, Modal } from '@nexus/ui';

type ActionKey = 'note' | 'task' | 'reply' | 'snooze' | 'edit' | 'connection' | 'trash';

interface LeadActionWorkspaceProps {
  readonly note?: ReactNode;
  readonly task?: ReactNode;
  readonly reply?: ReactNode;
  readonly snooze?: ReactNode;
  readonly edit?: ReactNode;
  readonly connection?: ReactNode;
  readonly trash?: ReactNode;
}

const labels: Readonly<Record<ActionKey, string>> = {
  note: 'Add note',
  task: 'Create task',
  reply: 'Capture reply',
  snooze: 'Set cooldown',
  edit: 'Edit lead',
  connection: 'Record connection',
  trash: 'Delete',
};

export function LeadActionWorkspace(props: LeadActionWorkspaceProps): ReactElement {
  const [active, setActive] = useState<ActionKey | null>(null);
  const actions: readonly ActionKey[] = ['note', 'task', 'reply', 'snooze', 'connection', 'edit', 'trash'];
  const content = active === null ? undefined : props[active];

  return (
    <>
      <div className="nx-action-bar" aria-label="Lead actions">
        {actions.map((action) => {
          if (props[action] === undefined) return null;
          return (
            <Button
              key={action}
              variant={action === 'trash' ? 'danger' : action === 'reply' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => setActive(action)}
            >
              {action === 'task' ? '+ Task' : labels[action]}
            </Button>
          );
        })}
      </div>

      {active !== null && content !== undefined && (
        <Modal title={labels[active]} onClose={() => setActive(null)} wide={active === 'reply' || active === 'edit'}>
          {content}
        </Modal>
      )}
    </>
  );
}
