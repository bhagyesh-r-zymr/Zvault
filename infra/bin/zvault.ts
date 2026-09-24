import { App } from 'aws-cdk-lib';
import { addZvaultStacks } from '../src/app.js';
import { loadStageConfig } from '../src/config.js';

const app = new App();
addZvaultStacks(app, loadStageConfig(app));
app.synth();
