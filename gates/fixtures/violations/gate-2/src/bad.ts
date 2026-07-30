/*
 * Copyright 2026 Seillen Ltd
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
// v2 is unscoped, and the crypto packages are not under the SDK scope either;
// the gate matched on the scope alone and let both through.
import AWS from 'aws-sdk';
import { Sha256 } from '@aws-crypto/sha256-js';

export const planted = [DynamoDBClient, AWS, Sha256];
