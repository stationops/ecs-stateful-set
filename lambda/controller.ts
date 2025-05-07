import {
    ECSClient,
    ListTasksCommand,
    DescribeTasksCommand,
    RunTaskCommand,
    StopTaskCommand, Task,
} from '@aws-sdk/client-ecs';
import {
    DynamoDBClient,
    PutItemCommand,
    DeleteItemCommand,
} from '@aws-sdk/client-dynamodb';

import { acquireLock, releaseLock } from './lock';
import {getActiveTasks, startTask, stopTask, waitForIp} from './task';
import {handleNetwork, deleteDnsRecordForTask, createDnsRecordForTask} from './dns';
import { deregisterTarget, registerTarget } from './target';
import {
    handleVolumes,
    getSnapshotIdForTaskIndex,
    getVolumeIdForTaskIndex,
    handleStorage, hasVolumeForIndexWithoutSnapshot,
    snapshotVolumeForIndex
} from './storage';
import { hasInFlightSnapshotsOrTasks } from './action';

const ecs = new ECSClient({});
const ddb = new DynamoDBClient({});

const CLUSTER_NAME = process.env.CLUSTER_NAME!;
const TASK_DEFINITION_ARN = process.env.TASK_DEFINITION_ARN!;
const DESIRED_REPLICAS = parseInt(process.env.DESIRED_REPLICAS!);
const LOCK_TABLE_NAME = process.env.LOCK_TABLE_NAME!;
const LOCK_ID = 'replica-controller-lock';

const subnetIds = process.env.SUBNET_IDS!.split(',');
const securityGroupId = process.env.SECURITY_GROUP_ID!;

const HOSTED_ZONE_ID = process.env.HOSTED_ZONE_ID!;
const DNS_DOMAIN = process.env.DNS_DOMAIN!;
const ECS_VOLUME_TASK_ROLE = process.env.ECS_VOLUME_TASK_ROLE!;


async function runTask(tasks: any, runningCount : number, activeCount : number){
    if (runningCount < DESIRED_REPLICAS) {
        const usedIndexes = new Set(tasks.map((t : any) => t.index));
        const nextIndex = [...Array(DESIRED_REPLICAS).keys()].find(i => !usedIndexes.has(i));

        if (nextIndex === undefined) {
            console.log('No available index found to start a new task.');
            return;
        }

        const snapshotId = await getSnapshotIdForTaskIndex(nextIndex);

        if(await hasVolumeForIndexWithoutSnapshot(nextIndex)){
            console.log('Has non snapshoted volumes before task recreation, will defer');
            return
        }else{
            console.log(`All volumes for index ${nextIndex} have been snapshoted`);
        }

        const newTask = await startTask(
            CLUSTER_NAME,
            TASK_DEFINITION_ARN,
            nextIndex,
            subnetIds,
            securityGroupId,
            ECS_VOLUME_TASK_ROLE,
            snapshotId
        );

        if(!newTask || !newTask.taskArn){
            return
        }

        const ipTask = await waitForIp(CLUSTER_NAME, newTask.taskArn)

        if(!ipTask){
            return
        }

        await createDnsRecordForTask({task: ipTask, hostedZoneId: HOSTED_ZONE_ID, index: nextIndex, dnsDomain: DNS_DOMAIN})

    } else if (activeCount > DESIRED_REPLICAS) {

        const taskToStop = tasks.reduce(((a : any, b : any) => (a.index > b.index ? a : b)));

        console.log('tearing down task for index ' + taskToStop.index);

        await deregisterTarget(taskToStop.task, process.env.TARGET_GROUP_ARN!);
        await deleteDnsRecordForTask({
            task: taskToStop.task,
            hostedZoneId: HOSTED_ZONE_ID,
            index: taskToStop.index,
            dnsDomain: DNS_DOMAIN,
        });

        await stopTask(CLUSTER_NAME, taskToStop.arn);


    } else {
        console.log('Desired replica count is already met');
    }

}

export const handler = async () => {
    console.log("*** Starting control loop ***")
    const shouldSkip = await hasInFlightSnapshotsOrTasks(CLUSTER_NAME);
    if (shouldSkip) return;

    const gotLock = await acquireLock(LOCK_TABLE_NAME, LOCK_ID);
    if (!gotLock) return;

    try {
        await handleStorage();

        const tasks = await getActiveTasks(CLUSTER_NAME, TASK_DEFINITION_ARN);
        const runningCount = tasks.filter(t => t.status === 'RUNNING').length;
        const activeCount = tasks.length;

        console.log(`Active tasks: ${activeCount}, Running: ${runningCount}, Desired: ${DESIRED_REPLICAS}`);

        await runTask(tasks, runningCount, activeCount)


        await handleNetwork({tasks, hostedZoneId: HOSTED_ZONE_ID, dnsDomain: DNS_DOMAIN, targetGroupArn: process.env.TARGET_GROUP_ARN!})
        await handleStorage();

        console.log("*** Ending control loop ***")

    } catch (err) {
        console.error('Error in controller:', err);
    } finally {
        await releaseLock(LOCK_TABLE_NAME, LOCK_ID);
    }
};
