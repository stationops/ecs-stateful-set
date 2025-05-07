// run from demo dir with: npx tsc ; cdk --app "npx ts-node mysql.ts"  deploy

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as path from 'node:path';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import {KeyValuePair} from "@aws-sdk/client-ecs/dist-types/models/models_0";

export interface StatefulSetProps {
  readonly name: string;
  readonly taskDefinition: ecs.FargateTaskDefinition;
  readonly cluster: ecs.ICluster;
  readonly hostedZone: route53.IHostedZone;
  readonly replicas: number;
  readonly subnets?: ec2.ISubnet[];
  readonly securityGroup: ec2.ISecurityGroup;
  readonly environment?: Record<string, string>
  readonly vpc: ec2.IVpc;
  readonly volumeSize?: number;
  readonly enableExecuteCommand? : boolean;
}

// Capitalize construct ID segments (e.g. "my-app" -> "MyApp")
function capitalizeId(name: string): string {
  return name.replace(/(^\w|-\w)/g, s => s.replace('-', '').toUpperCase());
}

export class StatefulSet extends Construct {
  public readonly targetGroup: elbv2.ApplicationTargetGroup;

  constructor(scope: Construct, id: string, props: StatefulSetProps) {
    super(scope, id);

    const region = cdk.Aws.REGION;    // AWS region (e.g., 'us-west-2')
    const account = cdk.Aws.ACCOUNT_ID;

    const idPrefix = capitalizeId(props.name);

    const subnetIds = props.subnets
        ? props.subnets.map(s => s.subnetId)
        : props.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds;

    const lockTable = new dynamodb.Table(this, `${idPrefix}LockTable`, {
      partitionKey: { name: 'LockID', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.targetGroup = new elbv2.ApplicationTargetGroup(this, `${idPrefix}TargetGroup`, {
      vpc: props.vpc,
      port: props.taskDefinition.defaultContainer?.containerPort || 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
      },
    });

    const volumeRole = new iam.Role(this, `${idPrefix}EcsTaskRoleWithVolumePermissions`, {
      assumedBy: new iam.ServicePrincipal('ecs.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSInfrastructureRolePolicyForVolumes'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchLogsFullAccess')
      ],
    });

    const fn = new NodejsFunction(this, `${idPrefix}Controller`, {
      entry: path.join(__dirname, '../lambda/controller.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(15),
      runtime: lambda.Runtime.NODEJS_22_X,
      environment: {
        ECS_VOLUME_TASK_ROLE: volumeRole.roleArn,
        TASK_DEFINITION_ARN: props.taskDefinition.taskDefinitionArn,
        CONTAINER_NAME: props.taskDefinition.defaultContainer?.containerName || '',
        HOSTED_ZONE_ID: props.hostedZone.hostedZoneId,
        CLUSTER_NAME: props.cluster.clusterName,
        DESIRED_REPLICAS: props.replicas.toString(),
        LOCK_TABLE_NAME: lockTable.tableName,
        SUBNET_IDS: subnetIds.join(','),
        SECURITY_GROUP_ID: props.securityGroup.securityGroupId,
        DNS_PREFIX: props.name,
        TASK_ENVIRONMENT: JSON.stringify(props.environment || {}),
        DNS_DOMAIN: props.hostedZone.zoneName,
        TARGET_GROUP_ARN: this.targetGroup.targetGroupArn,
        STATEFULSET_NAME: props.name,
        VOLUME_SIZE: String(props.volumeSize || 20),
        COMMAND_EXECUTION: String(props.enableExecuteCommand || 'false')
      },
    });

    lockTable.grantReadWriteData(fn);

    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'ecs:RunTask'
      ],
      resources: [
        props.taskDefinition.taskDefinitionArn,
        props.cluster.clusterArn,
      ],
    }));



    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'ecs:StopTask',
        'ecs:DescribeTasks',
        'ecs:ListTasks',
      ],
      resources: [
        "*",
      ],
      conditions: {
        'StringEquals': {
          "ecs:cluster": props.cluster.clusterArn
        }
      }
    }));

    const rolesArns : string[] = []

    rolesArns.push(volumeRole.roleArn)

    if(props.taskDefinition.taskRole?.roleArn){
      rolesArns.push(props.taskDefinition.taskRole?.roleArn)
    }

    if(props.taskDefinition.executionRole?.roleArn){
      rolesArns.push(props.taskDefinition.executionRole?.roleArn)
    }

    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: rolesArns
    }));


    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'elasticloadbalancing:RegisterTargets',
        'elasticloadbalancing:DeregisterTargets'
      ],
      resources: [
        this.targetGroup.targetGroupArn
      ],
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'elasticloadbalancing:DescribeTargetHealth'
      ],
      resources: [
        "*"
      ],
    }));



    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'ec2:DescribeSnapshots',
        'ec2:DescribeVolumes'
      ],
      resources: [
        `*`,
      ]
    }))


    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'ec2:CreateSnapshot',
        'ec2:CreateVolume',
        'ec2:CreateTags',
      ],
      resources: [
        `*`,
      ]
    }));


    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['route53:ChangeResourceRecordSets'],
      resources: ['*']
    }));


    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'ec2:DeleteSnapshot',
        'ec2:DeleteVolume'
      ],
      resources: ['*'],
      conditions: {
        'StringEquals': {
          [`ec2:ResourceTag/ess:${props.name}:managed`]: 'true'
        }
      }
    }));



    cdk.Tags.of(fn).add('Component', `${props.name}-controller`);

    new events.Rule(this, `${idPrefix}EveryMinuteRule`, {
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new targets.LambdaFunction(fn)],
    });


    new events.Rule(this, `${idPrefix}TaskStateChangeRule`, {
      eventPattern: {
        source: ['aws.ecs'],
        detailType: ['ECS Task State Change'],
        detail: {
          clusterArn: [props.cluster.clusterArn],
          group: [{ prefix: props.taskDefinition.family? `family:${props.taskDefinition.family}` : undefined}],
        },
      },
      targets: [new targets.LambdaFunction(fn)],
    });
  }
}
