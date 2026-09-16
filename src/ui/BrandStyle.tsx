/**
 * A school's theme, as a stylesheet.
 *
 * `css` is produced by `themeCss` in core/branding/theme.ts, which admits only
 * validated six-digit hex and a fixed list of property names, and throws rather
 * than emit anything else. That is the only reason `dangerouslySetInnerHTML` is
 * acceptable here: the string was never text a person typed.
 *
 * Rendered in the body, after the linked stylesheets, so its `:root` rules win
 * at equal specificity — the same selectors `globals.css` uses, later in the
 * document.
 */
export function BrandStyle({ css }: { css: string | null }) {
  if (!css) return null;
  return <style data-brand-theme="" dangerouslySetInnerHTML={{ __html: css }} />;
}
