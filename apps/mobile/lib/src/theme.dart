import 'package:flutter/material.dart';

/// "Porcelain" colours. Light and dark sets; widgets read the current one
/// with `context.zv`.
@immutable
class ZvColors extends ThemeExtension<ZvColors> {
  const ZvColors({
    required this.brightness,
    required this.bg,
    required this.panel,
    required this.well,
    required this.line,
    required this.ink,
    required this.muted,
    required this.accent,
    required this.onAccent,
    required this.accentSoft,
    required this.digits,
    required this.symbols,
    required this.ok,
    required this.okSoft,
    required this.attention,
    required this.attentionSoft,
    required this.danger,
    required this.dangerSoft,
    required this.navy,
  });

  final Brightness brightness;

  /// Page background.
  final Color bg;

  /// Cards, sheets and the navigation bar.
  final Color panel;

  /// Inputs and inset areas.
  final Color well;
  final Color line;

  /// Body text.
  final Color ink;
  final Color muted;
  final Color accent;
  final Color onAccent;
  final Color accentSoft;

  /// Digits and symbols in secrets.
  final Color digits;
  final Color symbols;

  final Color ok;
  final Color okSoft;
  final Color attention;
  final Color attentionSoft;
  final Color danger;
  final Color dangerSoft;

  /// The navy brand tile (lighter in dark mode so it stays visible).
  final Color navy;

  static const light = ZvColors(
    brightness: Brightness.light,
    bg: Color(0xFFFFFFFF),
    panel: Color(0xFFFFFFFF),
    well: Color(0xFFF7F9FC),
    line: Color(0xFFE4E8F0),
    ink: Color(0xFF10204A),
    muted: Color(0xFF65718C),
    accent: Color(0xFF2F63D9),
    onAccent: Color(0xFFFFFFFF),
    accentSoft: Color(0xFFE6EEFC),
    digits: Color(0xFF2F63D9),
    symbols: Color(0xFFE0573F),
    ok: Color(0xFF0F8A6A),
    okSoft: Color(0xFFE2F4EE),
    attention: Color(0xFFC9771F),
    attentionSoft: Color(0xFFFFF4E2),
    danger: Color(0xFFD63A4A),
    dangerSoft: Color(0xFFFDECEE),
    navy: Color(0xFF10204A),
  );

  static const dark = ZvColors(
    brightness: Brightness.dark,
    bg: Color(0xFF141C33),
    panel: Color(0xFF1A2440),
    well: Color(0xFF18213B),
    line: Color(0xFF26324F),
    ink: Color(0xFFE9EEFA),
    muted: Color(0xFF8E9AB8),
    accent: Color(0xFF5B8BF5),
    onAccent: Color(0xFFFFFFFF),
    accentSoft: Color(0xFF1F2F5C),
    digits: Color(0xFF7EA6FF),
    symbols: Color(0xFFFF8A70),
    ok: Color(0xFF3CC79A),
    okSoft: Color(0xFF15332C),
    attention: Color(0xFFF2A94A),
    attentionSoft: Color(0xFF3A2C17),
    danger: Color(0xFFFF6B78),
    dangerSoft: Color(0xFF3A1C26),
    navy: Color(0xFF34467A),
  );

  @override
  ZvColors copyWith() => this;

  @override
  ZvColors lerp(ZvColors? other, double t) {
    if (other == null) return this;
    Color l(Color a, Color b) => Color.lerp(a, b, t)!;
    return ZvColors(
      brightness: t < 0.5 ? brightness : other.brightness,
      bg: l(bg, other.bg),
      panel: l(panel, other.panel),
      well: l(well, other.well),
      line: l(line, other.line),
      ink: l(ink, other.ink),
      muted: l(muted, other.muted),
      accent: l(accent, other.accent),
      onAccent: l(onAccent, other.onAccent),
      accentSoft: l(accentSoft, other.accentSoft),
      digits: l(digits, other.digits),
      symbols: l(symbols, other.symbols),
      ok: l(ok, other.ok),
      okSoft: l(okSoft, other.okSoft),
      attention: l(attention, other.attention),
      attentionSoft: l(attentionSoft, other.attentionSoft),
      danger: l(danger, other.danger),
      dangerSoft: l(dangerSoft, other.dangerSoft),
      navy: l(navy, other.navy),
    );
  }
}

extension ZvContext on BuildContext {
  /// The current Porcelain colours.
  ZvColors get zv => Theme.of(this).extension<ZvColors>() ?? ZvColors.light;
}

/// Non-colour design tokens.
abstract final class Zv {
  static const radiusS = 8.0;
  static const radiusM = 12.0;
  static const radiusL = 14.0;
  static const radiusXl = 20.0;

  /// Titles.
  static const display = 'PlusJakartaSans';

  /// Body text.
  static const font = 'Onest';

  /// Secrets and codes.
  static const mono = 'JetBrainsMono';

  static const monoStyle = TextStyle(fontFamily: mono, fontSize: 15, fontWeight: FontWeight.w500);

  /// A large page title, as in "Items".
  static const pageTitle = TextStyle(
    fontFamily: display,
    fontSize: 26,
    fontWeight: FontWeight.w800,
    letterSpacing: -0.8,
    height: 1.15,
  );
}

ThemeData zvaultTheme([ZvColors c = ZvColors.light]) {
  final dark = c.brightness == Brightness.dark;
  final scheme = ColorScheme.fromSeed(seedColor: c.accent, brightness: c.brightness).copyWith(
    primary: c.accent,
    onPrimary: c.onAccent,
    primaryContainer: c.accentSoft,
    onPrimaryContainer: c.accent,
    secondary: c.accent,
    onSecondary: c.onAccent,
    secondaryContainer: c.accentSoft,
    onSecondaryContainer: c.accent,
    surface: c.bg,
    onSurface: c.ink,
    onSurfaceVariant: c.muted,
    surfaceContainerLowest: c.panel,
    surfaceContainerLow: c.panel,
    surfaceContainer: c.panel,
    surfaceContainerHigh: c.panel,
    surfaceContainerHighest: c.well,
    error: c.danger,
    outline: c.line,
    outlineVariant: c.line,
  );
  final base = ThemeData(
    useMaterial3: true,
    brightness: c.brightness,
    colorScheme: scheme,
    fontFamily: Zv.font,
    scaffoldBackgroundColor: c.bg,
    canvasColor: c.bg,
    splashFactory: InkSparkle.splashFactory,
    extensions: [c],
  );
  TextStyle display(double size, FontWeight w, {double spacing = -0.3}) => TextStyle(
    fontFamily: Zv.display,
    fontSize: size,
    fontWeight: w,
    letterSpacing: spacing,
    color: c.ink,
  );
  return base.copyWith(
    textTheme: base.textTheme
        .apply(bodyColor: c.ink, displayColor: c.ink, fontFamily: Zv.font)
        .copyWith(
          headlineMedium: Zv.pageTitle.copyWith(color: c.ink),
          headlineSmall: display(20, FontWeight.w800, spacing: -0.4),
          titleLarge: display(19, FontWeight.w700),
          titleMedium: TextStyle(
            fontFamily: Zv.font,
            fontSize: 16,
            fontWeight: FontWeight.w600,
            color: c.ink,
          ),
          bodyLarge: TextStyle(fontFamily: Zv.font, fontSize: 16, color: c.ink, height: 1.45),
          bodyMedium: TextStyle(fontFamily: Zv.font, fontSize: 14, color: c.muted, height: 1.45),
          labelSmall: TextStyle(
            fontFamily: Zv.font,
            fontSize: 11,
            fontWeight: FontWeight.w500,
            color: c.muted,
          ),
        ),
    appBarTheme: AppBarTheme(
      backgroundColor: c.bg,
      foregroundColor: c.accent,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
      iconTheme: IconThemeData(color: c.accent),
      titleTextStyle: display(18, FontWeight.w700),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: c.accent,
        foregroundColor: c.onAccent,
        disabledBackgroundColor: c.line,
        disabledForegroundColor: c.muted,
        minimumSize: const Size.fromHeight(50),
        elevation: 0,
        textStyle: const TextStyle(
          fontFamily: Zv.display,
          fontSize: 15,
          fontWeight: FontWeight.w700,
        ),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Zv.radiusM)),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: c.accent,
        backgroundColor: c.accentSoft,
        minimumSize: const Size.fromHeight(50),
        side: BorderSide.none,
        textStyle: const TextStyle(
          fontFamily: Zv.display,
          fontSize: 15,
          fontWeight: FontWeight.w700,
        ),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Zv.radiusM)),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        foregroundColor: c.accent,
        textStyle: const TextStyle(fontFamily: Zv.font, fontSize: 15, fontWeight: FontWeight.w600),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Zv.radiusM)),
      ),
    ),
    iconButtonTheme: IconButtonThemeData(style: IconButton.styleFrom(foregroundColor: c.muted)),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: c.well,
      hintStyle: TextStyle(color: c.muted),
      prefixIconColor: c.muted,
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(Zv.radiusM),
        borderSide: BorderSide(color: c.line),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(Zv.radiusM),
        borderSide: BorderSide(color: c.line),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(Zv.radiusM),
        borderSide: BorderSide(color: c.accent, width: 1.5),
      ),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: c.panel,
      indicatorColor: c.accentSoft,
      indicatorShape: const StadiumBorder(),
      surfaceTintColor: Colors.transparent,
      shadowColor: Colors.transparent,
      elevation: 0,
      height: 68,
      iconTheme: WidgetStateProperty.resolveWith(
        (s) =>
            IconThemeData(color: s.contains(WidgetState.selected) ? c.accent : c.muted, size: 22),
      ),
      labelTextStyle: WidgetStateProperty.resolveWith(
        (s) => TextStyle(
          fontFamily: Zv.font,
          fontSize: 12,
          fontWeight: s.contains(WidgetState.selected) ? FontWeight.w600 : FontWeight.w500,
          color: s.contains(WidgetState.selected) ? c.ink : c.muted,
        ),
      ),
    ),
    dividerTheme: DividerThemeData(color: c.line, thickness: 1, space: 1),
    listTileTheme: ListTileThemeData(
      iconColor: c.accent,
      textColor: c.ink,
      titleTextStyle: TextStyle(
        fontFamily: Zv.font,
        fontSize: 15,
        fontWeight: FontWeight.w500,
        color: c.ink,
      ),
    ),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: dark ? c.accentSoft : c.ink,
      contentTextStyle: TextStyle(
        fontFamily: Zv.font,
        color: dark ? c.ink : Colors.white,
        fontSize: 14,
      ),
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Zv.radiusM)),
    ),
    chipTheme: ChipThemeData(
      backgroundColor: c.panel,
      selectedColor: c.accentSoft,
      side: WidgetStateBorderSide.resolveWith(
        (s) => BorderSide(color: s.contains(WidgetState.selected) ? c.accent : c.line),
      ),
      // Chips resolve only the colour by state, so the style itself is plain.
      labelStyle: TextStyle(
        fontFamily: Zv.font,
        fontSize: 13,
        fontWeight: FontWeight.w600,
        color: WidgetStateColor.resolveWith(
          (s) => s.contains(WidgetState.selected) ? c.accent : c.ink,
        ),
      ),
      shape: const StadiumBorder(),
    ),
    segmentedButtonTheme: SegmentedButtonThemeData(
      style: SegmentedButton.styleFrom(
        backgroundColor: c.well,
        foregroundColor: c.muted,
        selectedBackgroundColor: c.accentSoft,
        selectedForegroundColor: c.accent,
        side: BorderSide(color: c.line),
        textStyle: const TextStyle(fontFamily: Zv.font, fontSize: 14, fontWeight: FontWeight.w600),
      ),
    ),
    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: c.panel,
      surfaceTintColor: Colors.transparent,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(Zv.radiusXl)),
      ),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: c.panel,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Zv.radiusXl)),
      titleTextStyle: display(19, FontWeight.w700),
      contentTextStyle: TextStyle(fontFamily: Zv.font, fontSize: 14, color: c.muted, height: 1.45),
    ),
    radioTheme: RadioThemeData(
      fillColor: WidgetStateProperty.resolveWith(
        (s) => s.contains(WidgetState.selected) ? c.accent : c.muted,
      ),
    ),
    progressIndicatorTheme: ProgressIndicatorThemeData(color: c.accent),
  );
}
