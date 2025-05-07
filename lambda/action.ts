import { ECSClient, ListTasksCommand, DescribeTasksCommand } from '@aws-sdk/client-ecs';
import { EC2Client, DescribeSnapshotsCommand } from '@aws-sdk/client-ec2';

const ecs = new ECSClient({});
const ec2 = new EC2Client({});

export async function hasInFlightSnapshotsOrTasks(cluster: string): Promise<boolean> {

    const snapshotsResp = await ec2.send(new DescribeSnapshotsCommand({
        Filters: [
            { Name: `tag:ess:${process.env.STATEFULSET_NAME}:managed`, Values: [ "true" ] }, // Match StatefulSet name
            { Name: 'status', Values: ['pending', 'in-progress'] },
        ],
        OwnerIds: ['self'],
    }));

    if ((snapshotsResp.Snapshots?.length ?? 0) > 0) {
        console.log('Snapshots still in progress. Skipping this run.');
        return true;
    }

    // 2. Check ECS for tasks in provisioning/deprovisioning with the "ess:${process.env.STATEFULSET_NAME}:managed" tag
    const stopped = await ecs.send(new ListTasksCommand({ cluster, desiredStatus : "STOPPED" }));
    const running = await ecs.send(new ListTasksCommand({ cluster, desiredStatus : "RUNNING" }));
    const allTasks = [...stopped.taskArns || [], ...running.taskArns || []]
    if (allTasks.length === 0) {
        console.log('no tasks')
        return false;
    }

    const describeResp = await ecs.send(new DescribeTasksCommand({
        cluster,
        tasks: allTasks,
        include: ['TAGS'],
    }));

    const TEN_MINUTES_MS = 10 * 60 * 1000;
    const now = new Date();

    const inflightTasks = (describeResp.tasks || []).filter(task =>
        (!task.stoppedAt ||
        (now.getTime() - new Date(task.stoppedAt).getTime() < TEN_MINUTES_MS)) &&
        // Filtering tasks with the "ess:${process.env.STATEFULSET_NAME}:managed" tag and in provisioning or stopping states
        task.tags?.some(tag => tag.key === `ess:${process.env.STATEFULSET_NAME}:index`) &&
        ['DEPROVISIONING', 'PROVISIONING', 'PENDING', 'STOPPING', 'DEACTIVATING'].includes(task.lastStatus || '')
    );

    if (inflightTasks.length > 0) {
        console.log(`Tasks still transitioning: ${inflightTasks.length}. Skipping this run.`);
        return true;
    }

    return false;
}
