# upforbeers setup

Standing up the whole thing by hand. Assumes `us-west-2`, the AWS CLI configured, and that you swap in your own values where marked. Run the steps top to bottom.

Set these once in your shell so the later commands paste cleanly:

```sh
export AWS_REGION=us-west-2
export ACCOUNT_ID=123456789012        # your account id
export TABLE=upforbeers
export FN=upforbeers
export ROLE=upforbeers-lambda-role
```

## 1. GitHub repo and first push

```sh
git add -A
git commit -m "upforbeers"
gh repo create upforbeers --public --source=. --remote=origin --push
# or, without the gh CLI:
# git remote add origin git@github.com:YOURNAME/upforbeers.git
# git push -u origin main
```

## 2. VAPID keys

```sh
npx web-push generate-vapid-keys
```

You get a public and a private key. The **public** key is the one that goes in `config.js` and into the Lambda `VAPID_PUBLIC_KEY` env var. The **private** key goes into SSM in step 4 and never leaves the backend. They are a matched pair: if they ever disagree, every push is rejected with a 403.

```sh
export VAPID_PUBLIC=BPExamplePublicKey...
export VAPID_PRIVATE=ExamplePrivateKey...
export PASSPHRASE='pick a shared word'
```

## 3. DynamoDB table

```sh
aws dynamodb create-table \
  --region "$AWS_REGION" \
  --table-name "$TABLE" \
  --billing-mode PAY_PER_REQUEST \
  --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
  --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE

aws dynamodb wait table-exists --region "$AWS_REGION" --table-name "$TABLE"

aws dynamodb update-time-to-live \
  --region "$AWS_REGION" \
  --table-name "$TABLE" \
  --time-to-live-specification "Enabled=true,AttributeName=ttl"
```

TTL is best effort. DynamoDB deletes expired items within about 48 hours, so the Lambda also filters on `expiresAt` when it reads. TTL is just the janitor.

## 4. Secrets in SSM Parameter Store

Standard parameters are free. Secrets Manager charges per secret per month, and we do not need it here.

```sh
aws ssm put-parameter --region "$AWS_REGION" \
  --name /upforbeers/vapid-private --type SecureString \
  --value "$VAPID_PRIVATE" --overwrite

aws ssm put-parameter --region "$AWS_REGION" \
  --name /upforbeers/passphrase --type SecureString \
  --value "$PASSPHRASE" --overwrite
```

## 5. IAM execution role

Trust policy so Lambda can assume the role:

```sh
cat > /tmp/trust.json <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow",
      "Principal": { "Service": "lambda.amazonaws.com" },
      "Action": "sts:AssumeRole" }
  ]
}
JSON

aws iam create-role \
  --role-name "$ROLE" \
  --assume-role-policy-document file:///tmp/trust.json

aws iam attach-role-policy \
  --role-name "$ROLE" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
```

Look up the account's default SSM KMS key ARN so we can scope `kms:Decrypt` to exactly that key, no wildcard:

```sh
export SSM_KEY_ARN=$(aws kms describe-key --region "$AWS_REGION" \
  --key-id alias/aws/ssm --query KeyMetadata.Arn --output text)
echo "$SSM_KEY_ARN"
```

Inline policy scoped to just this table, just these two parameters, and just that key:

```sh
cat > /tmp/inline.json <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "Table",
      "Effect": "Allow",
      "Action": [
        "dynamodb:Query",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem"
      ],
      "Resource": "arn:aws:dynamodb:${AWS_REGION}:${ACCOUNT_ID}:table/${TABLE}"
    },
    {
      "Sid": "Params",
      "Effect": "Allow",
      "Action": "ssm:GetParameter",
      "Resource": [
        "arn:aws:ssm:${AWS_REGION}:${ACCOUNT_ID}:parameter/upforbeers/vapid-private",
        "arn:aws:ssm:${AWS_REGION}:${ACCOUNT_ID}:parameter/upforbeers/passphrase"
      ]
    },
    {
      "Sid": "Decrypt",
      "Effect": "Allow",
      "Action": "kms:Decrypt",
      "Resource": "${SSM_KEY_ARN}"
    }
  ]
}
JSON

aws iam put-role-policy \
  --role-name "$ROLE" \
  --policy-name upforbeers-inline \
  --policy-document file:///tmp/inline.json

export ROLE_ARN=$(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text)
```

## 6. Build and create the Lambda

The Node 22 runtime already ships the AWS SDK v3, so only `web-push` gets bundled. That keeps the zip small.

```sh
cd lambda
npm install --omit=dev
zip -r ../function.zip index.mjs package.json node_modules >/dev/null
cd ..
```

Give the role a few seconds to propagate before the first create, otherwise you can get an assume-role error:

```sh
sleep 10

aws lambda create-function \
  --region "$AWS_REGION" \
  --function-name "$FN" \
  --runtime nodejs22.x \
  --role "$ROLE_ARN" \
  --handler index.handler \
  --timeout 15 \
  --memory-size 256 \
  --zip-file fileb://function.zip \
  --environment "Variables={TABLE_NAME=$TABLE,VAPID_PUBLIC_KEY=$VAPID_PUBLIC,VAPID_SUBJECT=mailto:you@example.com,APP_URL=https://upforbeers.philipknott.net}"
```

Redeploy command to rerun on every code change:

```sh
cd lambda && npm install --omit=dev >/dev/null && \
  zip -r ../function.zip index.mjs package.json node_modules >/dev/null && cd .. && \
  aws lambda update-function-code --region "$AWS_REGION" \
    --function-name "$FN" --zip-file fileb://function.zip
```

## 7. Function URL with locked down CORS

```sh
aws lambda create-function-url-config \
  --region "$AWS_REGION" \
  --function-name "$FN" \
  --auth-type NONE \
  --cors '{
    "AllowOrigins": ["https://upforbeers.philipknott.net"],
    "AllowMethods": ["GET","POST"],
    "AllowHeaders": ["content-type","x-beer-key"],
    "MaxAge": 300
  }'
```

`AllowOrigins: ["*"]` would let any page on the internet POST to `/broadcast` and buzz everyone's phone. Restrict it to the one origin that is allowed to.

A public Function URL still needs an explicit resource permission, even with `--auth-type NONE`:

```sh
aws lambda add-permission \
  --region "$AWS_REGION" \
  --function-name "$FN" \
  --statement-id FunctionURLAllowPublicAccess \
  --action lambda:InvokeFunctionUrl \
  --principal "*" \
  --function-url-auth-type NONE

export FUNCTION_URL=$(aws lambda get-function-url-config --region "$AWS_REGION" \
  --function-name "$FN" --query FunctionUrl --output text | sed 's:/*$::')
echo "$FUNCTION_URL"
```

Smoke test it before touching the frontend. CORS only applies to browsers, so curl ignores it:

```sh
# empty roster, zero cooldown
curl -s "$FUNCTION_URL/state?userId=test" ; echo

# auth rejects a bad key
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$FUNCTION_URL/broadcast" \
  -H 'content-type: application/json' -H 'x-beer-key: wrong' \
  -d '{"userId":"test","name":"Test"}'     # expect 401

# right key writes a signal and fans out (0 notified until someone subscribes)
curl -s -X POST "$FUNCTION_URL/broadcast" \
  -H 'content-type: application/json' -H "x-beer-key: $PASSPHRASE" \
  -d '{"userId":"test","name":"Test"}' ; echo

# the signal now shows up
curl -s "$FUNCTION_URL/state?userId=other" ; echo

# a second immediate broadcast trips the cooldown
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$FUNCTION_URL/broadcast" \
  -H 'content-type: application/json' -H "x-beer-key: $PASSPHRASE" \
  -d '{"userId":"test","name":"Test"}'     # expect 429

# clean the test signal back out
curl -s -X POST "$FUNCTION_URL/leave" \
  -H 'content-type: application/json' -d '{"userId":"test"}' ; echo
```

## 8. Log retention

CloudWatch keeps Lambda logs forever by default. Cap it:

```sh
aws logs put-retention-policy --region "$AWS_REGION" \
  --log-group-name "/aws/lambda/$FN" --retention-in-days 14
```

If the group does not exist yet, invoke the function once (the curl above does it) and rerun this.

## 9. Fill in config.js and push

Edit `config.js` with the real values and commit:

```sh
# FUNCTION_URL is echoed above, VAPID_PUBLIC is from step 2
```

```js
window.UB_CONFIG = {
  FUNCTION_URL: 'https://xxxx.lambda-url.us-west-2.on.aws',
  VAPID_PUBLIC_KEY: 'BPExamplePublicKey...',
};
```

```sh
git add config.js && git commit -m "wire config" && git push
```

The passphrase is never in here. Only the two public values live in `config.js`.

## 10. GitHub Pages

The repo already contains `CNAME` (`upforbeers.philipknott.net`) and `.nojekyll`.

1. Repo Settings, Pages. Set Source to `Deploy from a branch`, branch `main`, folder `/ (root)`.
2. The Custom domain field should already read `upforbeers.philipknott.net` from the `CNAME` file. If not, type it and save.
3. Wait for the certificate to provision, then tick **Enforce HTTPS**. Web push will not work over plain HTTP.

## 11. Route 53

Point the subdomain at GitHub Pages. Note the trailing dot:

```sh
export ZONE_ID=$(aws route53 list-hosted-zones-by-name \
  --dns-name philipknott.net --query 'HostedZones[0].Id' --output text)

cat > /tmp/dns.json <<'JSON'
{
  "Changes": [
    { "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "upforbeers.philipknott.net.",
        "Type": "CNAME",
        "TTL": 300,
        "ResourceRecords": [ { "Value": "filupnot.github.io." } ]
      }
    }
  ]
}
JSON

aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" \
  --change-batch file:///tmp/dns.json
```

## 12. Test on a real iPhone

Simulators cannot receive web push, so use a physical device.

1. Open `https://upforbeers.philipknott.net` in Safari.
2. Share, then **Add to Home Screen**. Web push on iOS only works from an installed app.
3. Open upforbeers from the new Home Screen icon (not from Safari).
4. Enter your name.
5. Tap the pint. Grant the notification permission when Safari asks. This prompt only appears on a real tap, never on load.
6. On a second device (or have a friend), install and enable the same way, then broadcast. The first phone should buzz with "Name is up for beers." Tap the pint on the second phone to join; the first phone sees the roster update.

## 13. Billing alarm at 5 dollars

Billing metrics live in `us-east-1` regardless of where your resources are.

```sh
aws cloudwatch put-metric-alarm --region us-east-1 \
  --alarm-name upforbeers-billing-5usd \
  --namespace AWS/Billing --metric-name EstimatedCharges \
  --dimensions Name=Currency,Value=USD \
  --statistic Maximum --period 21600 --evaluation-periods 1 \
  --threshold 5 --comparison-operator GreaterThanThreshold
```

To actually get emailed, create an SNS topic, subscribe your address, confirm the email, and add `--alarm-actions <topic-arn>` to the command above. (Billing alerts must also be enabled once in the Billing console under Billing preferences.)

## Troubleshooting

**The permission prompt does nothing / never appears.** You are not in standalone mode. iOS only grants web push to apps opened from the Home Screen icon. If you opened the link in Safari, you will see the install screen instead of the pint. Add to Home Screen and open from there.

**CORS error in the browser console.** Either the request origin is not exactly `https://upforbeers.philipknott.net` (a trailing slash or `www.` counts as different), or you added a header the Function URL CORS config does not list. Only `content-type` and `x-beer-key` are allowed. Update the `--cors` config in step 7 if you add headers.

**Push returns 403.** The VAPID public key the browser subscribed with does not match the private key the Lambda signs with. This happens if you regenerated keys, or pasted the public key into `config.js` but a different private key into SSM. They must be the same pair. Fix the mismatch, then unsubscribe and resubscribe on the device (deleting and reinstalling from the Home Screen forces a fresh subscription).

**Notifications work, then stop after a while.** A push arrived and the service worker showed nothing, so iOS revoked the permission. The `push` handler in `sw.js` must call `showNotification` on every push, including malformed ones. If you edit `sw.js`, keep that guarantee. Reinstall from the Home Screen to get permission back.
