#!/usr/bin/env node
import { resolve } from 'node:path'
import { render } from 'ink'
import React from 'react'
import { App } from './tui/app.js'

render(<App start={resolve(process.argv[2] ?? process.cwd())} />)
