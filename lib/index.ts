// import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
// import * as sqs from 'aws-cdk-lib/aws-sqs';

export interface EcsstatefulsetProps {
  // Define construct properties here
}

export class Ecsstatefulset extends Construct {

  constructor(scope: Construct, id: string, props: EcsstatefulsetProps = {}) {
    super(scope, id);

    // Define construct contents here

    // example resource
    // const queue = new sqs.Queue(this, 'EcsstatefulsetQueue', {
    //   visibilityTimeout: cdk.Duration.seconds(300)
    // });
  }
}
