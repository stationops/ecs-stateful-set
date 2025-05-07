import {
    Route53Client,
    ChangeResourceRecordSetsCommand,
} from '@aws-sdk/client-route-53';
import { Task } from '@aws-sdk/client-ecs';
import {registerTarget, removeExtraTargets} from "./target";
import {extractPrivateIp} from "./task";

const r53 = new Route53Client({});

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

    // await removeExtraTargets(tasks, targetGroupArn)
}



export async function createDnsRecordForTask({
                                                 task,
                                                 hostedZoneId,
                                                 index,
                                                 dnsDomain,
                                             }: {
    task: Task;
    hostedZoneId: string;
    index: number;
    dnsDomain: string;
}) {

    const privateIp = extractPrivateIp(task)
    if (!privateIp) {
        console.warn(`Could not find private IP for task ${task.taskArn}`);
        return;
    }

    // Use the STATEFULSET_NAME and index to generate the DNS name
    const statefulSetName = process.env.STATEFULSET_NAME!;
    const recordName = `${statefulSetName}-${index}.${dnsDomain}`;
    console.log(`setting ip ${privateIp}`);

    await r53.send(
        new ChangeResourceRecordSetsCommand({
            HostedZoneId: hostedZoneId,
            ChangeBatch: {
                Changes: [
                    {
                        Action: 'UPSERT',
                        ResourceRecordSet: {
                            Name: recordName,
                            Type: 'A',
                            TTL: 5,
                            ResourceRecords: [{ Value: privateIp }],
                        },
                    },
                ],
            },
        }),
    );
}

export async function deleteDnsRecordForTask({
                                                 task,
                                                 hostedZoneId,
                                                 index,
                                                 dnsDomain,
                                             }: {
    task: Task;
    hostedZoneId: string;
    index: number;
    dnsDomain: string;
}) {

    const privateIp = extractPrivateIp(task)
    if (!privateIp) {
        console.warn(`No private IP found on task ${task.taskArn}, skipping DNS deletion`);
        return;
    }

    // Use the STATEFULSET_NAME and index to generate the DNS name
    const statefulSetName = process.env.STATEFULSET_NAME!;
    const recordName = `${statefulSetName}-${index}.${dnsDomain}`;
    console.log(`Deleting DNS record: ${recordName} -> ${privateIp}`);

    try{
        await r53.send(
            new ChangeResourceRecordSetsCommand({
                HostedZoneId: hostedZoneId,
                ChangeBatch: {
                    Changes: [
                        {
                            Action: 'DELETE',
                            ResourceRecordSet: {
                                Name: recordName,
                                Type: 'A',
                                TTL: 5,
                                ResourceRecords: [{ Value: privateIp }],
                            },
                        },
                    ],
                },
            }),
        );
    }catch (e){
        console.warn(`Failed to delete host ${recordName} for ${privateIp}`)
    }

}
