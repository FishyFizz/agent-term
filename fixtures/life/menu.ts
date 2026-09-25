/**
 * The menuconfig-shaped mode: a menu you navigate with the arrow keys, where
 * each item opens a window of one of four kinds, and a "back" that returns to
 * the shell.
 *
 * The widgets are @clack/prompts; the frame is ours. Clack renders a linear
 * flow, so we clear the alt screen and redraw before each menu pass -- that is
 * what makes it read as one persistent menu instead of a growing scroll of
 * past menus.
 *
 * Each item carries its current value as a hint, the way menuconfig shows
 * `[*]` and `(value)` beside an entry. That is also how the driver can see
 * that opening a window actually did something.
 */

import { confirm, intro, isCancel, note, select, text } from '@clack/prompts';

import { ALT_SCREEN_OFF, ALT_SCREEN_ON, CLEAR, HOME, type LifeCtx } from './ctx.js';

const ITEM_NAMES: readonly string[] = [
  'cute-little-sheep',
  'big-red-apple',
  'tiny-brass-lantern',
  'quiet-gray-river',
  'sleepy-green-tractor',
  'bold-purple-kettle',
  'lazy-copper-moon',
  'brave-tiny-mushroom',
];

const VARIANTS: readonly string[] = ['small', 'medium', 'large', 'auto'];

const DETAILS: readonly string[] = [
  'Last changed three builds ago. No dependencies.',
  'Read-only while a job is running.',
  'Inherits from the workspace default unless set here.',
  'Setting this invalidates the incremental cache.',
];

type WindowKind = 'text' | 'choice' | 'toggle' | 'info';

const WINDOW_KINDS: readonly WindowKind[] = ['text', 'choice', 'toggle', 'info'];

const BACK = '__back__';

export async function runMenu(ctx: LifeCtx): Promise<void> {
  const { rng, pacer, out, router } = ctx;

  out.write(ALT_SCREEN_ON);
  router.handOff();
  try {
    const names = rng.shuffle(ITEM_NAMES).slice(0, rng.int(4, 5));
    const kinds = names.map(() => rng.pick(WINDOW_KINDS));
    const values = new Map<string, string>();

    for (;;) {
      out.write(CLEAR + HOME);
      intro('lifelike configuration');

      const choice = await select({
        message: 'Select an item',
        options: [
          ...names.map((name) => ({ value: name, label: name, hint: values.get(name) ?? '(unset)' })),
          { value: BACK, label: 'back', hint: 'return to the shell' },
        ],
      });

      if (isCancel(choice)) break;
      const chosen = String(choice);
      if (chosen === BACK) break;

      const index = names.indexOf(chosen);
      await openWindow(kinds[index] ?? 'info', chosen, ctx, values);
      await pacer.wait(rng.range(400, 1_200));
    }
  } finally {
    out.write(ALT_SCREEN_OFF);
    router.takeBack();
  }
}

async function openWindow(
  kind: WindowKind,
  name: string,
  ctx: LifeCtx,
  values: Map<string, string>,
): Promise<void> {
  const { rng } = ctx;

  switch (kind) {
    case 'text': {
      const value = await text({
        message: `New value for ${name}`,
        placeholder: 'type a value',
      });
      values.set(name, isCancel(value) ? 'cancelled' : String(value).trim() || '(empty)');
      return;
    }

    case 'choice': {
      const value = await select({
        message: `Variant for ${name}`,
        options: VARIANTS.map((variant) => ({ value: variant, label: variant })),
      });
      values.set(name, isCancel(value) ? 'cancelled' : String(value));
      return;
    }

    case 'toggle': {
      const value = await confirm({
        message: `Enable ${name}?`,
        initialValue: rng.next() < 0.5,
      });
      values.set(name, isCancel(value) ? 'cancelled' : value ? 'on' : 'off');
      return;
    }

    case 'info': {
      note(rng.pick(DETAILS) ?? 'No further information.', name);
      values.set(name, 'viewed');
      return;
    }
  }
}
