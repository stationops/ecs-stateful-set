import {
    ElasticLoadBalancingV2Client,
    RegisterTargetsCommand,
    DeregisterTargetsCommand,
    DescribeTargetHealthCommand, TargetDescription,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { Task } from '@aws-sdk/client-ecs';
import {extractPrivateIp} from "./task";

const elbv2 = new ElasticLoadBalancingV2Client({});



export async function registerTarget(task: Task, targetGroupArn: string) {
    const ip = extractPrivateIp(task);
    if (!ip) {
        console.warn(`Cannot register task ${task.taskArn}: no private IP found`);
        return;
    }

    await elbv2.send(new RegisterTargetsCommand({
        TargetGroupArn: targetGroupArn,
        Targets: [{ Id: ip }],
    }));

}


export async function removeExtraTargets(tasks: any[], targetGroupArn: string) {
    console.log("Checking for extra targets...");

    // Extract IPs of valid tasks
    const validIps = new Set<string>();

    for (const task of tasks) {
        const ip = extractPrivateIp(task.task)
        if (ip) {
            validIps.add(ip);
        }
    }

    // Get current targets in the target group
    const targetHealthResp = await elbv2.send(new DescribeTargetHealthCommand({
        TargetGroupArn: targetGroupArn,
    }));

    const extraTargets: TargetDescription[] = [];

    for (const target of targetHealthResp.TargetHealthDescriptions || []) {
        const ip = target.Target?.Id;
        if (ip && !validIps.has(ip)) {
            extraTargets.push({ Id: ip });
        }
    }

    if (extraTargets.length > 0) {
        console.log(`Removing ${extraTargets.length} extra targets...`);
        await elbv2.send(new DeregisterTargetsCommand({
            TargetGroupArn: targetGroupArn,
            Targets: extraTargets,
        }));
    } else {
        console.log("No extra targets to remove.");
    }
}

export async function deregisterTarget(task: Task, targetGroupArn: string) {
    const ip = extractPrivateIp(task);
    if (!ip) {
        console.warn(`Cannot deregister task ${task.taskArn}: no private IP found`);
        return;
    }

    console.log(`Deregistering target IP ${ip} for task ${task.taskArn}`);
    await elbv2.send(new DeregisterTargetsCommand({
        TargetGroupArn: targetGroupArn,
        Targets: [{ Id: ip, Port: 80 }],
    }));

}
