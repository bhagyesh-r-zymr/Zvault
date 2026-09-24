import { useState, useSyncExternalStore } from 'react';
import type { OrgSummary } from '@zvault/shared';
import type { TeamStore } from '../projects/team.js';
import { teamError } from '../projects/teamApi.js';
import { ErrorLine, Sheet } from '../ui/controls.js';
import { Icon } from '../ui/Icon.js';

/**
 * Sidebar entries for organization invites waiting on this account, so
 * someone with no projects yet can still find and accept them.
 */
export function TeamInvites(props: { store: TeamStore; onAccepted: () => void }) {
  const { orgs } = useSyncExternalStore(props.store.subscribe, props.store.get);
  const [open, setOpen] = useState<OrgSummary | null>(null);
  const invites = orgs.filter((o) => o.status === 'invited');

  return (
    <>
      {invites.map((o) => (
        <button key={o.id} type="button" className="nav-item" onClick={() => setOpen(o)}>
          <Icon name="mail" size={15} />
          <span className="label truncate">Team invite from {o.name}</span>
          <span className="count">1</span>
        </button>
      ))}
      {open && (
        <AcceptInviteSheet
          org={open}
          store={props.store}
          onClose={() => setOpen(null)}
          onAccepted={() => {
            setOpen(null);
            props.onAccepted();
          }}
        />
      )}
    </>
  );
}

function AcceptInviteSheet(props: {
  org: OrgSummary;
  store: TeamStore;
  onClose: () => void;
  onAccepted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      await props.store.acceptInvite(props.org.id);
      props.onAccepted();
    } catch (e) {
      setError(teamError(e, 'The invite could not be accepted.'));
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={`Join ${props.org.name}`}
      subtitle="You were invited to this organization"
      icon={<Icon name="people" size={18} />}
      onClose={props.onClose}
      width={460}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <p className="secondary" style={{ margin: 0 }}>
          Accepting publishes this account&apos;s sharing key to {props.org.name}, so a manager can
          hand you the keys of the projects and environments you were given access to. They show up
          under Projects once a manager has done that.
        </p>
        <ErrorLine error={error} />
        <div className="sheet-actions">
          <button type="button" onClick={props.onClose}>
            Not now
          </button>
          <button type="button" className="primary" disabled={busy} onClick={() => void accept()}>
            {busy ? 'Joining…' : 'Accept invite'}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
