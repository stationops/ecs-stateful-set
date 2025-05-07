import {
    DescribeTasksCommand,
    ECSClient,
    ListTasksCommand,
    RunTaskCommand,
    StopTaskCommand,
    Task,
} from '@aws-sdk/client-ecs';
import {KeyValuePair} from "@aws-sdk/client-ecs/dist-types/models/models_0";
import {EC2Client} from "@aws-sdk/client-ec2";

const ecs = new ECSClient({});


export function extractPrivateIp(task: Task | undefined): string | undefined {
    if(!task){
        return undefined
    }
    const eniAttachment = task.attachments?.find(att =>
        att.type === "ElasticNetworkInterface"
    );
    return eniAttachment?.details?.find(d => d.name === 'privateIPv4Address')?.value
}


export async function waitForIp(clusterName: string, taskArn: string) {
    const ecs = new ECSClient({});
    const ec2 = new EC2Client({});

    let ip: string | undefined;
    let task: Task | undefined;
    let taskStatus = "";

    while (!ip) {
        const { tasks } = await ecs.send(
            new DescribeTasksCommand({
                cluster: clusterName,
                tasks: [taskArn],
            })
        );

        task = tasks?.[0];
        taskStatus = task?.lastStatus ?? "";

        ip = extractPrivateIp(task)

        if (!ip) {
            console.log("waiting for ip")
            await new Promise((res) => setTimeout(res, 50));
        }else{
            console.log('found ip ' + ip)
        }
    }

    return task;
}

export async function getActiveTasks(cluster: string, taskDefinitionArn: string): Promise<{ arn: string; index: number; status: string, task: Task }[]> {
    const family = taskDefinitionArn.split('/')[1];

    const listResp = await ecs.send(
        new ListTasksCommand({
            desiredStatus: 'RUNNING',
            cluster,
        //    family,
        }),
    );

    if (!listResp.taskArns || listResp.taskArns.length === 0) return [];

    const describeResp = await ecs.send(
        new DescribeTasksCommand({
            cluster,
            tasks: listResp.taskArns,
            include: ['TAGS'],
        }),
    );

    return (describeResp.tasks || [])
        .map(task => {
            const tags = task.tags || [];
            const index = parseInt(tags.find(t => t.key === `ess:${process.env.STATEFULSET_NAME}:index`)?.value || '-1');
            return {
                task: task,
                arn: task.taskArn!,
                status: task.lastStatus!,
                index,
            };
        })
        .filter(t => t.index >= 0);
}

export async function startTask(
    cluster: string,
    taskDefinitionArn: string,
    index: number,
    subnets: string[],
    securityGroupId: string,
    volumeTaskRoleArn: string,
    snapshotId?: string
): Promise<Task | undefined> {
    console.log(`Starting task with index ${index} ${snapshotId ? `from snapshot ${snapshotId}` : ''}`);

    const tags = [
        { key: `ess:${process.env.STATEFULSET_NAME}:index`, value: index.toString() },
        { key: `ess:${process.env.STATEFULSET_NAME}:managed`, value: 'true' },
    ];

    if(snapshotId){
        tags.push({ key: `ess:${process.env.STATEFULSET_NAME}:snapshot-id`, value: snapshotId })
    }

    const extraEnvs: Record<string, string> = JSON.parse(process.env.TASK_ENVIRONMENT || '{}')

    const environmentOverrides: KeyValuePair[] = Object.entries(extraEnvs).map(
        ([name, value]) => ({ name, value: value.replace(/\$index/g, String(index)), })
    );

    const result = await ecs.send(
        new RunTaskCommand({
            cluster,
            taskDefinition: taskDefinitionArn,
            launchType: 'FARGATE',
            count: 1,
            enableExecuteCommand: process.env.COMMAND_EXECUTION === 'true',
            networkConfiguration: {
                awsvpcConfiguration: {
                    subnets,
                    securityGroups: [securityGroupId]
                },
            },
            overrides: {
                containerOverrides: [
                    {
                        name: process.env.CONTAINER_NAME,
                        environment: environmentOverrides,
                    },
                ],
            },
            volumeConfigurations: [
                {
                    name: 'volume',
                    managedEBSVolume: {
                        sizeInGiB: parseInt(process.env.VOLUME_SIZE || '20'),
                        snapshotId: snapshotId,
                        roleArn: volumeTaskRoleArn,
                        terminationPolicy: {
                            deleteOnTermination: false
                        },
                        tagSpecifications: [
                            {
                                resourceType: "volume",
                                tags: tags
                            }
                        ],
                    },
                }
            ],
            tags: tags,
        }),
    );

    const taskArn = result.tasks?.[0]?.taskArn;

    if (!taskArn) {
        console.warn('No task returned from RunTaskCommand');
        return undefined;
    }

    // Wait for the task to become visible in DescribeTasks
    let isVisible = false;
    let finalTask: Task | undefined = undefined;
    const maxWaitMs: number = 120_000
    const pollIntervalMs: number = 3000
    const start = Date.now();

    while (!isVisible && Date.now() - start < maxWaitMs) {
        const describeResp = await ecs.send(
            new DescribeTasksCommand({
                cluster,
                tasks: [taskArn],
            })
        );

        const task = describeResp.tasks?.[0];
        if (task) {
            isVisible = true;
            finalTask = task;
            break;
        }

        await new Promise(res => setTimeout(res, pollIntervalMs));
    }

    if (!isVisible) {
        throw new Error(`Task ${taskArn} not visible in DescribeTasks after ${maxWaitMs / 1000} seconds`);
    }

    return finalTask;
}

export async function stopTask(
    cluster: string,
    taskArn: string
): Promise<Task | undefined> {
    // Describe the task first to get ENI/IP info
    const describeResp = await ecs.send(
        new DescribeTasksCommand({
            cluster,
            tasks: [taskArn],
        })
    );

    const task = describeResp.tasks?.[0];

    if (!task) {
        console.warn(`Task not found: ${taskArn}`);
        return;
    }

    console.log(`Stopping task: ${taskArn}`);
    await ecs.send(
        new StopTaskCommand({
            cluster,
            task: taskArn,
            reason: 'Scaling down replicas to match StatefulSet configuration',
        })
    );

    return task;
}