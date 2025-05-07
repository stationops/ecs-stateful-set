import * as cdk from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import {FargateTaskDefinition} from 'aws-cdk-lib/aws-ecs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import {Role} from 'aws-cdk-lib/aws-iam';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import {ApplicationProtocol} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import {StatefulSet} from "../lib";
import * as logs from 'aws-cdk-lib/aws-logs';
import * as targets from 'aws-cdk-lib/aws-route53-targets';


function createZookeeperTaskDefinition(scope : Construct, taskRole : Role) : FargateTaskDefinition {



    const logGroup = new logs.LogGroup(scope, 'ZookeeperLogGroup', {
        logGroupName: '/ecs/zookeeper',
        removalPolicy: cdk.RemovalPolicy.DESTROY, // or RETAIN in production
    });

    const taskDefinition = new ecs.FargateTaskDefinition(scope, 'ZookeeperTaskDefinition', {
        memoryLimitMiB: 2048,
        cpu: 1024,
        taskRole: taskRole,
        volumes: [
            {
                name: 'volume',
                configuredAtLaunch: true
            }
        ]
    });

    const cd = taskDefinition.addContainer('ZookeeperContainer', {
        image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/zookeeper:3.9.3'),
        logging: ecs.LogDriver.awsLogs({
            streamPrefix: 'zookeeper',
            logGroup: logGroup,
        }),
        environment: {
            ZOO_DATA_DIR: '/data',
            ZOO_DATA_LOG_DIR: '/data',
        },
        portMappings: [
            { containerPort: 2181 }, // client port
            { containerPort: 2888 }, // follower communication
            { containerPort: 3888 }, // leader election
        ]
    });

    cd.addMountPoints({
        sourceVolume: 'volume',
        containerPath: '/data',
        readOnly: false
    });

    return taskDefinition;


}

function createPinotTaskDefinition(scope : Construct, taskRole : Role, component : string, zkAddress : string, command : string, ports: number[]) : FargateTaskDefinition {


    const logGroup = new logs.LogGroup(scope,  component + 'LogGroup', {
        logGroupName: '/ecs/' + component,
        removalPolicy: cdk.RemovalPolicy.DESTROY, // or RETAIN in production
    });

    const taskDefinition = new ecs.FargateTaskDefinition(scope, component + 'TaskDefinition', {
        memoryLimitMiB: 4096,
        cpu: 2048,
        taskRole: taskRole,
        volumes: [
            {
                name: 'volume',
                configuredAtLaunch: true
            }
        ]
    });

    const cd = taskDefinition.addContainer(component + 'Container', {
        memoryLimitMiB: 4096,
        cpu: 2048,
        image: ecs.ContainerImage.fromRegistry('apachepinot/pinot:latest'),
        logging: ecs.LogDriver.awsLogs({
            streamPrefix: component,
            logGroup: logGroup,
        }),
        command: [command, "-zkAddress", zkAddress],
        environment: {
            JAVA_HEAP_OPTS: "-Xms2g -Xmx2g"
        },
        portMappings: ports.map(p => ( { containerPort: p }))
    });

    cd.addMountPoints({
        sourceVolume: 'volume',
        containerPath: `/var/pinot/${component}/data`,
        readOnly: false
    });

    return taskDefinition;


}

export class MysqlStatefulSetStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        const vpc = new ec2.Vpc(this, 'PinotVPC', {
            maxAzs: 3,
        });

        const zookeeperCluster = new ecs.Cluster(this, 'ZkCluster', {
            vpc,
        });

        const pinotCluster = new ecs.Cluster(this, 'PinotCluster', {
            vpc,
        });


        const hostedZone = new route53.PrivateHostedZone(this, 'HostedZone', {
            zoneName: 'svc.internal',
            vpc: vpc
        });

        const taskRole = new iam.Role(this, `TaskRole`, {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
            ]
        });

        const zookeeperTaskDefinition = createZookeeperTaskDefinition(this, taskRole)

        const zookeeperSecurityGroup = new ec2.SecurityGroup(this, 'ZookeeperSecurityGroup', {
            vpc,
            allowAllOutbound: true,
        });
        zookeeperSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(2181));
        zookeeperSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(2888));
        zookeeperSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(3888));


        const pinotSecurityGroup = new ec2.SecurityGroup(this, 'PinotSecurityGroup', {
            vpc,
            allowAllOutbound: true,
        });
        pinotSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(9000));
        pinotSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(8998));
        pinotSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(8099));
        pinotSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(8097));
        pinotSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(8098));
        pinotSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(9514));
        pinotSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(2181));
        pinotSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(2888));
        pinotSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(3888));


        new StatefulSet(this, 'ZookeeperStatefulSet', {
            vpc: vpc,
            name: 'zk',
            cluster: zookeeperCluster,
            taskDefinition: zookeeperTaskDefinition,
            hostedZone: hostedZone,
            securityGroup: zookeeperSecurityGroup,
            enableExecuteCommand: true,
            replicas: 3,
            environment: {
                ZOO_SERVERS: "server.0=zk-0.svc.internal:2888:3888;2181 server.1=zk-1.svc.internal:2888:3888;2181 server.2=zk-2.svc.internal:2888:3888;2181",
                ZOO_MY_ID: '$index'
            }
        });

        const zkAddress = 'zk-0.svc.internal:2181,zk-1.svc.internal:2181,zk-2.svc.internal:2181'
        const controllerTaskDefinition = createPinotTaskDefinition(this,
            taskRole,
            'component',
            zkAddress,
            'StartController',
            [9000, 8998]
        )

        const brokerTaskDefinition = createPinotTaskDefinition(this,
            taskRole,
            'broker',
            zkAddress,
            'StartBroker',
            [8099]
        )

        const serverTaskDefinition = createPinotTaskDefinition(this,
            taskRole,
            'server',
            zkAddress,
            'StartServer',
            [8097, 8098]
        )
        const minionTaskDefinition = createPinotTaskDefinition(this,
            taskRole,
            'minion',
            zkAddress,
            'StartMinion',
            [9514]
        )


        const controllerStatefulSet = new StatefulSet(this, 'ControllerStatefulSet', {
            vpc: vpc,
            name: 'controller',
            cluster: pinotCluster,
            taskDefinition: controllerTaskDefinition,
            hostedZone: hostedZone,
            securityGroup: pinotSecurityGroup,
            enableExecuteCommand: true,
            replicas: 3
        });


        new StatefulSet(this, 'BrokerStatefulSet', {
            vpc: vpc,
            name: 'broker',
            cluster: pinotCluster,
            taskDefinition: brokerTaskDefinition,
            hostedZone: hostedZone,
            securityGroup: pinotSecurityGroup,
            enableExecuteCommand: true,
            replicas: 3
        });


        new StatefulSet(this, 'ServerStatefulSet', {
            vpc: vpc,
            name: 'server',
            cluster: pinotCluster,
            taskDefinition: serverTaskDefinition,
            hostedZone: hostedZone,
            securityGroup: pinotSecurityGroup,
            enableExecuteCommand: true,
            replicas: 3
        });


        new StatefulSet(this, 'MinionStatefulSet', {
            vpc: vpc,
            name: 'minion',
            cluster: pinotCluster,
            taskDefinition: minionTaskDefinition,
            hostedZone: hostedZone,
            securityGroup: pinotSecurityGroup,
            enableExecuteCommand: true,
            replicas: 1
        });


        const lbSecurityGroup = new ec2.SecurityGroup(this, 'InternalAccessSG', {
            vpc,
            description: 'Allow all traffic from within the VPC',
            allowAllOutbound: true,
        });

        lbSecurityGroup.addIngressRule(
            ec2.Peer.ipv4(vpc.vpcCidrBlock),
            ec2.Port.allTcp(),
            'Allow all TCP traffic from within the VPC'
        );

        const lb = new elbv2.ApplicationLoadBalancer(this, 'LoadBalancer', {
            vpc,
            securityGroup: lbSecurityGroup,
            internetFacing: false,
            loadBalancerName: 'pinot-lb',
            vpcSubnets: {subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS},

        });

        new route53.ARecord(this, 'ControllerARecord', {
            zone: hostedZone,
            recordName: 'controller', // => controller.svc.internal
            target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(lb)),
        });

        const listener = lb.addListener('HttpListener', {
            port: 9000,
            protocol: ApplicationProtocol.HTTP,
            defaultAction: elbv2.ListenerAction.forward([controllerStatefulSet.targetGroup])
        });

    }

}


// Create the CDK App
const app = new cdk.App();
new MysqlStatefulSetStack(app, 'PinotStack');