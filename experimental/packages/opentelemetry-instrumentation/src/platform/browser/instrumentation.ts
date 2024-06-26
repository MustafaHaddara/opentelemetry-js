/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { InstrumentationAbstract } from '../../instrumentation';
import * as types from '../../types';
import { InstrumentationConfig } from '../../types';

/**
 * Base abstract class for instrumenting web plugins
 */
export abstract class InstrumentationBase<
    ConfigType extends InstrumentationConfig = InstrumentationConfig,
  >
  extends InstrumentationAbstract<ConfigType>
  implements types.Instrumentation<ConfigType>
{
  constructor(
    instrumentationName: string,
    instrumentationVersion: string,
    config: ConfigType = {} as ConfigType // The cast here may be wrong as ConfigType may contain required fields
  ) {
    super(instrumentationName, instrumentationVersion, config);

    if (this._config.enabled) {
      this.enable();
    }
  }
}
