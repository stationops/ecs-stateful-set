// import * as cdk from 'aws-cdk-lib';
// import { Template } from 'aws-cdk-lib/assertions';
// import * as Ecsstatefulset from '../lib/index';



// example test. To run these tests, uncomment this file along with the
// example resource in lib/index.ts
import  { handler } from '../lib/lambda/controller'

jest.mock('../lib/lambda/action', () => ({
    __esModule: true,
    hasInFlightSnapshotsOrTasks: jest.fn(), // important: provide a mock function
}));

import { hasInFlightSnapshotsOrTasks } from '../lib/lambda/action';


test('Controller loops exists if inflight tasks', async () => {
    (hasInFlightSnapshotsOrTasks as jest.Mock).mockImplementation(() => true);

    await handler()
});
