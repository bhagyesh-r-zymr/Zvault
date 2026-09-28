import { useEffect, useState } from 'react';
import { Icon } from '../ui/Icon.js';
import { agents } from './api.js';

/** The unpacked extension, attached to every release. */
export const EXTENSION_DOWNLOAD =
  'https://github.com/bhagyesh-r-zymr/Zvault/releases/latest/download/zvault-chrome-extension.zip';

/**
 * How to add the browser extension. Zvault registers itself with every
 * Chrome-family browser it finds on launch; the extension then pairs through
 * the prompt the app shows, like an agent.
 */
export function BrowserSetup() {
  const [status, setStatus] = useState<{ bundled: boolean; browsers: string[] } | null>(null);

  useEffect(() => {
    agents.browserExtensionStatus().then(setStatus, () => setStatus(null));
  }, []);

  const ready = status?.bundled && status.browsers.length > 0;

  return (
    <div className="cli-setup">
      <div className="panel rows">
        <div className="row">
          <Icon
            name={ready ? 'check' : 'globe'}
            size={18}
            className={ready ? 'cli-ok' : 'secondary'}
          />
          <div className="row-main">
            <span className="row-title">
              {ready ? 'Zvault is ready for the browser extension' : 'Browser extension'}
            </span>
            <span className="row-sub">
              {!status
                ? 'Checking your browsers…'
                : !status.bundled
                  ? 'This build of Zvault does not include zv, which the extension needs.'
                  : status.browsers.length
                    ? `Registered with ${status.browsers.join(', ')}`
                    : 'Install Chrome, Brave, Edge, Arc or Chromium first.'}
            </span>
          </div>
        </div>
      </div>
      <ol className="hint cli-steps">
        <li>
          Download <a href={EXTENSION_DOWNLOAD}>zvault-chrome-extension.zip</a> and unzip it.
        </li>
        <li>
          Open <code>chrome://extensions</code>, turn on Developer mode and choose Load unpacked.
        </li>
        <li>Click the Zvault icon, then Connect, and check the code matches here.</li>
      </ol>
    </div>
  );
}
