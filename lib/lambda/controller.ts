
import { acquireLock, releaseLock } from './lock';
import {getActiveTasks, startTask, stopTask, waitForIp} from './task';
import {deleteDnsRecordForTask, createDnsRecordForTask} from './dns';
import {deregisterTarget, registerTarget, removeExtraTargets} from './target';
import {
    getSnapshotIdForTaskIndex,
    getVolumeIdForTaskIndex,
    hasVolumeForIndexWithoutSnapshot,
    snapshotVolumeForIndex,
    deleteDuplicateSnapshots,
    describeVolumes,
    describeVolumeSnapshots,
    deleteVolume,
    snapshotVolume
} from './storage';
import { hasInFlightSnapshotsOrTasks } from './action';


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

export async function handleNetwork({
                                        tasks,
                                        hostedZoneId,
                                        dnsDomain,
                                        targetGroupArn
                                    }: {
    tasks: any;
    hostedZoneId: string;
    dnsDomain: string;
    targetGroupArn: string;
}) {

    for(let task of tasks){
        await registerTarget(task.task, targetGroupArn)
        await createDnsRecordForTask({task: task.task, hostedZoneId, index: task.index, dnsDomain})
    }

    await removeExtraTargets(tasks, targetGroupArn)
}


export async function handleVolumes(): Promise<void> {
    console.log('Looking for orphaned volumes');

    const volumesResp = await describeVolumes();

    const orphanedVolumes = volumesResp.Volumes || [];

    for (const volume of orphanedVolumes) {
        const taskIndexTag = volume.Tags?.find(tag => tag.Key === `ess:${process.env.STATEFULSET_NAME}:index`);

        if(!volume.CreateTime){
            continue
        }

        const now = new Date();
        const ageInMs = now.getTime() - volume.CreateTime.getTime();
        const ageInMinutes = ageInMs / (1000 * 60);

        if(ageInMinutes < 2){
            // don't snapshot volumes that havent been attached yet
            continue
        }

        if (taskIndexTag?.Value === undefined || volume.VolumeId === undefined) {
            console.log(`No task index tag or volume found for: ${volume.VolumeId}, ${JSON.stringify(volume.Tags)}`)
            continue;
        }

        const taskIndex = parseInt(taskIndexTag.Value);

        const snapshotsResp = await describeVolumeSnapshots(volume.VolumeId)

        const hasSnapshot = (snapshotsResp.Snapshots?.length ?? 0) > 0;

        if (hasSnapshot) {
            console.log(`Deleting orphaned volume, with existing snapshot, ${volume.VolumeId} for task index ${taskIndex}`);
            console.log(`Creating snapshot for volume ${volume.VolumeId} in status ${volume.State}`)
            await deleteVolume(volume.VolumeId)
        } else {
            console.log(`Creating snapshot for: ${volume.VolumeId}`);
            await snapshotVolume(volume.VolumeId, taskIndex)

        }
    }
}


export async function handleStorage(){
    await handleVolumes()
    await deleteDuplicateSnapshots()
}

export const handler = async () => {
    console.log("*** Starting control loop ***")
    const shouldSkip = await hasInFlightSnapshotsOrTasks(CLUSTER_NAME);
    if (shouldSkip) {
        console.log('has inflight operations, skipping this run')
        return
    };

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
