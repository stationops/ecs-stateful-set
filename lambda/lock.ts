import {
    DynamoDBClient,
    PutItemCommand,
    DeleteItemCommand,
} from '@aws-sdk/client-dynamodb';

const ddb = new DynamoDBClient({});
const LOCK_TTL_SECONDS = 60;

export async function acquireLock(tableName: string, lockId: string): Promise<boolean> {
    const expiresAt = Math.floor(Date.now() / 1000) + LOCK_TTL_SECONDS;

    try {
        await ddb.send(
            new PutItemCommand({
                TableName: tableName,
                Item: {
                    LockID: { S: lockId },
                    ExpiresAt: { N: expiresAt.toString() },
                },
                ConditionExpression: 'attribute_not_exists(LockID)',
            }),
        );
        console.log('* Lock acquired *');
        return true;
    } catch (err: any) {
        if (err.name === 'ConditionalCheckFailedException') {
            console.log('Lock already held, exiting');
            return false;
        }
        throw err;
    }
}

export async function releaseLock(tableName: string, lockId: string): Promise<void> {
    await ddb.send(
        new DeleteItemCommand({
            TableName: tableName,
            Key: { LockID: { S: lockId } },
        }),
    );
    console.log('Lock released');
}
