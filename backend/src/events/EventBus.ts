import { AppEvent, EventName, EventPayloadMap } from '@shared/types';
import { logger } from '../observability/logger.js';
import { v4 as uuidv4 } from 'uuid';

export type EventHandler<K extends EventName> = (event: AppEvent<K>) => Promise<void>;

export class EventBus {
  private handlers: Map<string, EventHandler<any>[]> = new Map();

  /**
   * Subscribes a handler to a typed event
   */
  public subscribe<K extends EventName>(eventName: K, handler: EventHandler<K>): void {
    const list = this.handlers.get(eventName) ?? [];
    list.push(handler);
    this.handlers.set(eventName, list);
    logger.debug({ eventName }, 'Event handler registered');
  }

  /**
   * Publishes an event to all registered subscribers
   */
  public async publish<K extends EventName>(
    eventName: K,
    payload: EventPayloadMap[K],
    traceId?: string
  ): Promise<AppEvent<K>> {
    const event: AppEvent<K> = {
      eventId: uuidv4(),
      traceId: traceId ?? uuidv4(),
      eventName,
      timestamp: Date.now(),
      payload,
    };

    logger.info({ eventId: event.eventId, traceId: event.traceId, eventName }, 'Publishing event');

    const handlers = this.handlers.get(eventName) ?? [];
    const dispatchPromises = handlers.map(async (handler) => {
      try {
        await handler(event);
      } catch (err) {
        logger.error(
          {
            eventId: event.eventId,
            traceId: event.traceId,
            eventName,
            error: (err as Error).message,
          },
          'Error executing event handler'
        );
        throw err;
      }
    });

    await Promise.all(dispatchPromises);
    return event;
  }
}
