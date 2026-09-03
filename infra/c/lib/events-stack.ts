import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { EVENT_BUS_NAME, EVENT_RULE_NAME } from './config.js';

/**
 * The audit trail. Retail puts order events on the `orders` bus; a rule copies
 * everything from source `retail` onto a queue.
 *
 * Two dead-letter queues, doing different jobs. The rule DLQ catches events
 * EventBridge could not hand to the target at all. The queue DLQ catches
 * messages a consumer keeps failing on, after three receives.
 *
 * Separate stack from the apps so a redeploy of an app does not disturb the
 * archive or lose queued events.
 */
export class EventsStack extends cdk.Stack {
  readonly bus: events.EventBus;
  readonly queue: sqs.Queue;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    this.bus = new events.EventBus(this, 'OrdersBus', { eventBusName: EVENT_BUS_NAME });

    this.bus.archive('OrdersArchive', {
      archiveName: `${EVENT_BUS_NAME}-archive`,
      description: 'Order events, replayable for 7 days',
      eventPattern: { account: [this.account] },
      retention: cdk.Duration.days(7),
    });

    const queueDlq = new sqs.Queue(this, 'OrderEventsDlq', {
      queueName: 'order-events-dlq',
      retentionPeriod: cdk.Duration.days(14),
    });

    this.queue = new sqs.Queue(this, 'OrderEventsQueue', {
      queueName: 'order-events',
      visibilityTimeout: cdk.Duration.seconds(60),
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: { queue: queueDlq, maxReceiveCount: 3 },
    });

    // Undeliverable events, as opposed to unprocessable messages.
    const ruleDlq = new sqs.Queue(this, 'OrderEventsRuleDlq', {
      queueName: 'order-events-rule-dlq',
      retentionPeriod: cdk.Duration.days(14),
    });

    const rule = new events.Rule(this, 'OrderEventsRule', {
      ruleName: EVENT_RULE_NAME,
      eventBus: this.bus,
      description: 'Every event published by retail',
      eventPattern: { source: ['retail'] },
      targets: [new targets.SqsQueue(this.queue, { deadLetterQueue: ruleDlq })],
    });

    new cdk.CfnOutput(this, 'EventBusName', { value: this.bus.eventBusName });
    new cdk.CfnOutput(this, 'EventRuleName', { value: rule.ruleName });
    new cdk.CfnOutput(this, 'OrderEventsQueueUrl', { value: this.queue.queueUrl });
    new cdk.CfnOutput(this, 'OrderEventsDlqUrl', { value: queueDlq.queueUrl });
  }
}
