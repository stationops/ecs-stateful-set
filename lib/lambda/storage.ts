import {
    EC2Client,
    DescribeSnapshotsCommand,
    DescribeVolumesCommand,
    CreateSnapshotCommand,
    DeleteVolumeCommand,
    DeleteSnapshotCommand,
    Volume, DeleteVolumeCommandOutput,
    DescribeSnapshotsCommandOutput,
    DescribeVolumesCommandOutput
} from '@aws-sdk/client-ec2';
import {Task} from "@aws-sdk/client-ecs";

const ec2 = new EC2Client({});

/**
 * Finds the most recent EBS snapshot tagged with the given task index.
 * @param index Task index (e.g., 0, 1, 2...)
 * @returns Snapshot ID (if found), or undefined
 */
export async function getSnapshotIdForTaskIndex(index: number): Promise<string | undefined> {
    const result = await ec2.send(new DescribeSnapshotsCommand({
        Filters: [
            { Name: `tag:ess:${process.env.STATEFULSET_NAME}:index`, Values: [index.toString()] },
            { Name: `tag:ess:${process.env.STATEFULSET_NAME}:managed`, Values: ['true'] },
            { Name: 'status', Values: ['completed'] },
        ],
        OwnerIds: ['self'],
    }));

    const snapshots = result.Snapshots || [];

    if (snapshots.length > 0) {
        snapshots.sort((a, b) => (b.StartTime?.getTime() ?? 0) - (a.StartTime?.getTime() ?? 0));
        const snapshotId = snapshots[0].SnapshotId;
        return snapshotId;
    }

    console.log(`No snapshot found for task index ${index}`);
    return undefined;
}

export async function getVolumeIdForTaskIndex(index: number): Promise<string | undefined> {
    const result = await ec2.send(new DescribeVolumesCommand({
        Filters: [
            { Name: `tag:ess:${process.env.STATEFULSET_NAME}:index`, Values: [index.toString()] },
            { Name: 'status', Values: ['available', 'in-use'] }, // optional: filter for usable volumes
        ],
    }));

    const volumes = result.Volumes || [];

    if (volumes.length > 0) {
        volumes.sort((a, b) => (b.CreateTime?.getTime() ?? 0) - (a.CreateTime?.getTime() ?? 0));
        const volumeId = volumes[0].VolumeId;
        console.log(`Found volume ${volumeId} for task index ${index}`);
        return volumeId;
    }

    console.log(`No volume found for task index ${index}`);
    return undefined;
}

export async function hasVolumeForIndexWithoutSnapshot(index: number): Promise<boolean> {
    const result = await ec2.send(new DescribeVolumesCommand({
        Filters: [
            { Name: `tag:ess:${process.env.STATEFULSET_NAME}:index`, Values: [index.toString()] },
            { Name: 'status', Values: ['available', 'in-use'] }, // optional: filter for usable volumes
        ],
    }));

    const volumes = result.Volumes || [];

    for(let volume of volumes){
        if(!volume.VolumeId){
            console.log("Volume is missing id")
            continue
        }
        const result = await ec2.send(new DescribeSnapshotsCommand({
            Filters: [
                { Name: 'status', Values: ['completed'] },
                { Name: `tag:ess:${process.env.STATEFULSET_NAME}:volume-id`, Values: [volume.VolumeId] }
            ],
            OwnerIds: ['self'],
        }));

        const snapshots = result.Snapshots || [];

        if (snapshots.length == 0) {
            console.log('Volume has no snapshot: ' + volume.VolumeId)
            return true;
        }
    }

    return false;

}


export async function snapshotVolume(volumeId: string, index: number): Promise<void> {
    console.log(volumeId);


    const snapshot = await ec2.send(new CreateSnapshotCommand({
        VolumeId: volumeId,
        TagSpecifications: [
            {
                ResourceType: 'snapshot',
                Tags: [
                    { Key: `ess:${process.env.STATEFULSET_NAME}:index`, Value: index.toString() },
                    { Key: `ess:${process.env.STATEFULSET_NAME}:managed`, Value: 'true' },  // Adding managed tag
                    { Key: `ess:${process.env.STATEFULSET_NAME}:volume-id`, Value: volumeId },  // Adding managed tag
                ],
            },
        ],
        Description: `${process.env.STATEFULSET_NAME}: index ${index}`,
    }));

    console.log(`Created snapshot ${snapshot.SnapshotId} for volume ${volumeId}`);

    const snapshotId = snapshot.SnapshotId!;
    const maxWaitMs = 60_000; // 1 minute timeout
    const pollIntervalMs = 3_000;

    const start = Date.now();
    let isVisible = false;

    while (!isVisible && Date.now() - start < maxWaitMs) {
        const describe = await ec2.send(new DescribeSnapshotsCommand({
            SnapshotIds: [snapshotId],
        }));

        if (describe.Snapshots?.length) {
            isVisible = true;
            break;
        }

        await new Promise(res => setTimeout(res, pollIntervalMs));
    }

    if (!isVisible) {
        throw new Error(`Snapshot ${snapshotId} not visible in DescribeSnapshots after ${maxWaitMs / 1000} seconds`);
    }
}

export async function snapshotVolumeForIndex(task: Task, index: number): Promise<void> {

    console.log(`try snapshot`);

    const ebsAttachment = task.attachments?.find(a => a.type === "AmazonElasticBlockStorage");

    console.log(task.attachments);
    console.log(ebsAttachment);

    if(!ebsAttachment){
        return
    }

    const volumeId = ebsAttachment?.details?.find(d => d.name === "volumeId")?.value;

    if(!volumeId){
        return
    }

    await snapshotVolume(volumeId, index)

}

export async function deleteDuplicateSnapshots(): Promise<void> {
    console.log('Deleting old snapshots')
    const managedTagKey = `ess:${process.env.STATEFULSET_NAME}:managed`;
    const indexTagKey = `ess:${process.env.STATEFULSET_NAME}:index`;

    const snapshotsResp = await ec2.send(new DescribeSnapshotsCommand({
        Filters: [
            { Name: `tag:${managedTagKey}`, Values: ['true'] },
            { Name: 'status', Values: ['completed'] }
        ],
        OwnerIds: ['self']
    }));

    const snapshots = snapshotsResp.Snapshots || [];

    const grouped: Record<string, typeof snapshots> = {};

    for (const snapshot of snapshots) {

        if(!snapshot.VolumeId || !!await findVolume(snapshot.VolumeId)){
            // if a volume has not been deleted yet, don't delete its snapshot
            continue
        }

        const indexTag = snapshot.Tags?.find(tag => tag.Key === indexTagKey);
        if (!indexTag?.Value) continue;

        if (!grouped[indexTag.Value]) {
            grouped[indexTag.Value] = [];
        }

        grouped[indexTag.Value].push(snapshot);
    }

    for (const [index, group] of Object.entries(grouped)) {
        if (group.length <= 1) {
            continue; // nothing to delete
        }

        const sorted = group.sort((a, b) => {
            const aTime = a.StartTime?.getTime() ?? 0;
            const bTime = b.StartTime?.getTime() ?? 0;
            return bTime - aTime; // descending (newest first)
        });

        const [latest, ...duplicates] = sorted;


        for (const snapshot of duplicates) {
            if (snapshot.SnapshotId) {
                try {
                    await ec2.send(new DeleteSnapshotCommand({ SnapshotId: snapshot.SnapshotId }));
                    console.log(`Deleted snapshot ${snapshot.SnapshotId}`);
                } catch (err) {
                    console.error(`Failed to delete snapshot ${snapshot.SnapshotId}:`, err);
                }
            }
        }
    }
}

export async function deleteVolume(volumeId: string): Promise<DeleteVolumeCommandOutput> {
    return await ec2.send(new DeleteVolumeCommand({ VolumeId: volumeId }));
}

export async function findVolume(volumeId: string): Promise<Volume | undefined> {
    try {
        const volumesResp = await ec2.send(new DescribeVolumesCommand({
            VolumeIds: [volumeId],
            Filters: [
                { Name: 'status', Values: ['available'] },
                { Name: `tag:ess:${process.env.STATEFULSET_NAME}:managed`, Values: ['true'] },
            ],
        }));

        const volumes = volumesResp.Volumes || [];
        return volumes[0];
    } catch (err: any) {
        if (err.name === "InvalidVolume.NotFound") {
            return undefined;
        }

        // Re-throw if it's an unexpected error
        throw err;
    }
}

export async function describeVolumeSnapshots(volumeId: string) : Promise<DescribeSnapshotsCommandOutput> {
    return  await ec2.send(new DescribeSnapshotsCommand({
        Filters: [
            { Name: 'status', Values: ['completed', 'pending'] },
            { Name: `tag:ess:${process.env.STATEFULSET_NAME}:managed`, Values: ['true'] },
            { Name: `tag:ess:${process.env.STATEFULSET_NAME}:volume-id`, Values: [volumeId] }
        ],
        OwnerIds: ['self']
    }));
}


export async function describeVolumes() : Promise<DescribeVolumesCommandOutput> {
    return  await ec2.send(new DescribeVolumesCommand({
        Filters: [
            { Name: 'status', Values: ['available'] },
            { Name: `tag:ess:${process.env.STATEFULSET_NAME}:managed`, Values: ['true'] }
        ],
    }));
}




