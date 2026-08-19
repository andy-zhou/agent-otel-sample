import { tool } from 'ai'
import { z } from 'zod'

/**
 * Deliberately the whole tool surface. Arguments and results are trivial,
 * which keeps attention on where they show up in the two streams rather than
 * on what the tool does.
 */
export const calculator = tool({
  description: 'Evaluate one arithmetic operation on two numbers.',
  inputSchema: z.object({
    operation: z.enum(['add', 'subtract', 'multiply', 'divide']),
    a: z.number(),
    b: z.number(),
  }),
  execute: async ({ operation, a, b }) => {
    switch (operation) {
      case 'add':
        return { result: a + b }
      case 'subtract':
        return { result: a - b }
      case 'multiply':
        return { result: a * b }
      case 'divide':
        if (b === 0) throw new Error('division by zero')
        return { result: a / b }
    }
  },
})
