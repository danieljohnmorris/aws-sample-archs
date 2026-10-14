import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import type * as rds from 'aws-cdk-lib/aws-rds';
import type { Construct } from 'constructs';
import {
  ALB_LISTENER_PORT,
  databasePassword,
  databaseUrl,
  PHARMACY_CONTAINER_PORT,
  PHARMACY_HEALTH_PATH,
  PHARMACY_IMAGE,
  PREFIX,
} from './config.js';

export interface PharmacyAppStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
  readonly appSg: ec2.ISecurityGroup;
  readonly albSg: ec2.ISecurityGroup;
  readonly db: rds.IDatabaseInstance;
}

/**
 * Pharmacy: Fargate behind an internal ALB. No API Gateway, no public edge,
 * no IAM on the call. Retail reaches it because retail's security group is
 * the one the ALB's group admits.
 */
export class PharmacyAppStack extends cdk.Stack {
  /** Base URL retail calls from inside the VPC. */
  readonly internalBaseUrl: string;

  constructor(scope: Construct, id: string, props: PharmacyAppStackProps) {
    super(scope, id, props);

    const cluster = new ecs.Cluster(this, 'Cluster', { vpc: props.vpc, clusterName: `${PREFIX}-pharmacy` });
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      family: `${PREFIX}-pharmacy`,
      cpu: 256,
      memoryLimitMiB: 512,
    });
    taskDefinition.addContainer('pharmacy', {
      containerName: 'pharmacy',
      image: ecs.ContainerImage.fromRegistry(PHARMACY_IMAGE),
      portMappings: [{ containerPort: PHARMACY_CONTAINER_PORT, protocol: ecs.Protocol.TCP }],
      environment: {
        SERVICE_NAME: 'pharmacy',
        PORT: String(PHARMACY_CONTAINER_PORT),
        DATABASE_URL: databaseUrl('pharmacy', databasePassword(), props.db.dbInstanceEndpointPort, 'pharmacy'),
      },
    });

    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      serviceName: `${PREFIX}-pharmacy`,
      taskDefinition,
      desiredCount: 1,
      minHealthyPercent: 0,
      maxHealthyPercent: 200,
      assignPublicIp: false,
      securityGroups: [props.appSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: false },
    });

    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      loadBalancerName: `${PREFIX}-pharmacy-alb`,
      vpc: props.vpc,
      internetFacing: false,
      securityGroup: props.albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
    const listener = alb.addListener('Listener', {
      port: ALB_LISTENER_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false,
    });
    listener.addTargets('Pharmacy', {
      port: PHARMACY_CONTAINER_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: { path: PHARMACY_HEALTH_PATH, interval: cdk.Duration.seconds(30), healthyThresholdCount: 2 },
      deregistrationDelay: cdk.Duration.seconds(5),
    });

    // On AWS this is the whole address. floci answers <name>.elb.floci for
    // the containers it starts, which includes the retail Lambda.
    this.internalBaseUrl = `http://${alb.loadBalancerDnsName}:${ALB_LISTENER_PORT}`;

    // floci publishes the listener on the host, so tests reach pharmacy
    // directly. On AWS nothing outside the VPC could.
    new cdk.CfnOutput(this, 'PharmacyApiUrl', { value: `http://localhost:${ALB_LISTENER_PORT}` });
    new cdk.CfnOutput(this, 'PharmacyAlbArn', { value: alb.loadBalancerArn });
    new cdk.CfnOutput(this, 'PharmacyAlbDnsName', { value: alb.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'PharmacyInternalBaseUrl', { value: this.internalBaseUrl });
  }
}
