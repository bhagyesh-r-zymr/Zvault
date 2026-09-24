import { useState } from 'react';
import { Icon } from '../ui/Icon.js';
import { useProjects } from './context.js';
import type { Project } from './model.js';
import { ACCESS_LABELS, accessFor, type AccessEntry, type AccessLevel } from './preview.js';
import { PreviewNote, ProjectTile } from './ProjectsView.js';

const LEVELS: AccessLevel[] = ['manage', 'edit', 'use', 'approval', 'none'];

const LEGEND: { level: AccessLevel; text: string }[] = [
  { level: 'manage', text: 'Everything in Edit, plus who has access' },
  { level: 'edit', text: 'Add, change, rotate and share secrets' },
  { level: 'use', text: "Copy, fill and zv run; can't change or share" },
  { level: 'approval', text: 'Each use waits for a manager to approve' },
];

/** Who can use each environment of a project: groups, people and agents. */
export function ProjectAccess({ projectId }: { projectId: string }) {
  const { projects } = useProjects();
  const project = projects.find((p) => p.id === projectId);
  if (!project) {
    return (
      <div className="empty">
        <Icon name="people" size={32} />
        <span>This project is no longer available.</span>
      </div>
    );
  }
  // Start over when environments change, so every column has a level.
  const envKey = project.environments.map((e) => `${e.id}:${e.locked}`).join();
  return <AccessMatrix key={`${project.id}|${envKey}`} project={project} />;
}

function AccessMatrix({ project }: { project: Project }) {
  const [entries, setEntries] = useState<AccessEntry[]>(() => accessFor(project));

  const setLevel = (id: string, envId: string, level: AccessLevel) =>
    setEntries(
      entries.map((e) => (e.id === id ? { ...e, levels: { ...e.levels, [envId]: level } } : e)),
    );

  return (
    <div className="page">
      <div className="page-inner wide">
        <div className="page-head">
          <ProjectTile project={project} size="large" />
          <div>
            <h1>{project.name} · Access</h1>
            <p>
              Decide who can see each environment. Folders and tags follow the environment they sit
              in.
            </p>
          </div>
          <button type="button" disabled title="Arrives with team accounts">
            Invite people
          </button>
        </div>
        <PreviewNote>
          Sample team. Your own row is real; the rest, and any changes here, stay on this Mac until
          team accounts and roles ship.
        </PreviewNote>

        <div className="legend">
          {LEGEND.map((l) => (
            <div key={l.level} className="panel">
              <span
                className="level"
                data-level={l.level}
                style={{ display: 'inline-flex', alignItems: 'center' }}
              >
                {ACCESS_LABELS[l.level]}
              </span>
              {l.text}
            </div>
          ))}
        </div>

        <div className="panel" style={{ overflowX: 'auto' }}>
          <table className="access-table">
            <thead>
              <tr>
                <th scope="col">Who</th>
                {project.environments.map((env) => (
                  <th key={env.id} scope="col">
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span className="dot" style={{ background: env.color }} />
                      {env.name}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <th scope="row">
                    <span className="who">
                      <span
                        className="avatar large"
                        style={
                          entry.kind === 'agent'
                            ? { background: 'var(--attn-bg)', color: 'var(--attn)' }
                            : entry.kind === 'person'
                              ? { borderRadius: '50%', background: '#33203a', color: '#d9a3f5' }
                              : undefined
                        }
                      >
                        {entry.kind === 'agent' ? <Icon name="agent" size={15} /> : entry.name[0]}
                      </span>
                      <span>
                        <span className="row-title">{entry.name}</span>
                        <span className="row-sub">{entry.detail}</span>
                      </span>
                    </span>
                  </th>
                  {project.environments.map((env) => {
                    const level = entry.levels[env.id] ?? 'none';
                    return (
                      <td key={env.id}>
                        <select
                          className="level"
                          data-level={level}
                          aria-label={`${entry.name} in ${env.name}`}
                          value={level}
                          onChange={(e) =>
                            setLevel(entry.id, env.id, e.target.value as AccessLevel)
                          }
                        >
                          {LEVELS.filter(
                            (l) =>
                              entry.kind !== 'agent' ||
                              l === 'use' ||
                              l === 'approval' ||
                              l === 'none',
                          ).map((l) => (
                            <option key={l} value={l}>
                              {entry.kind === 'agent' && l === 'none' ? 'Never' : ACCESS_LABELS[l]}
                            </option>
                          ))}
                        </select>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="notice">
          <Icon name="shield" size={14} />
          Each environment is encrypted with its own key, so Production secrets are only ever sent
          to people and agents with Production access. Folders stay one level deep inside an
          environment.
        </p>
      </div>
    </div>
  );
}
