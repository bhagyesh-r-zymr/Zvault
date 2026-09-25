import 'package:flutter/material.dart';

/// "Graphite & Iris", the Mac app's design tokens (apps/desktop/src/ui/theme.css).
abstract final class Zv {
  static const bg = Color(0xFF0B0D12);
  static const sunken = Color(0xFF0F1218);
  static const surface = Color(0xFF141821);
  static const raised = Color(0xFF1C2230);
  static const selected = Color(0xFF1A2033);
  static const line = Color(0xFF262C3A);
  static const lineSoft = Color(0xFF1F2432);
  static const lineStrong = Color(0xFF2E3860);

  static const text = Color(0xFFE9EDF5);
  static const text2 = Color(0xFFA3ABBD);
  static const muted = Color(0xFF7E879B);

  static const iris = Color(0xFF4C5BE8);
  static const irisHover = Color(0xFF5A69F0);
  static const irisText = Color(0xFF8EA0FF);
  static const irisRing = Color(0xFF1D2350);

  static const secure = Color(0xFF45D6A0);
  static const secureBg = Color(0xFF10261F);
  static const secureLine = Color(0xFF1D4A3B);
  static const attn = Color(0xFFF2B64C);
  static const attnBg = Color(0xFF2B2413);
  static const attnLine = Color(0xFF54431F);
  static const danger = Color(0xFFFF9A9A);
  static const dangerBg = Color(0xFF2A1519);
  static const dangerLine = Color(0xFF5A2A30);

  static const radiusS = 8.0;
  static const radiusM = 10.0;
  static const radiusL = 14.0;
  static const radiusXl = 20.0;

  static const font = 'Geist';
  static const mono = 'GeistMono';

  static const monoStyle = TextStyle(fontFamily: mono, color: text, fontSize: 15);
}

ThemeData zvaultTheme() {
  const scheme = ColorScheme.dark(
    primary: Zv.iris,
    onPrimary: Colors.white,
    secondary: Zv.irisText,
    surface: Zv.surface,
    onSurface: Zv.text,
    error: Zv.danger,
    outline: Zv.line,
  );
  final base = ThemeData(
    useMaterial3: true,
    brightness: Brightness.dark,
    colorScheme: scheme,
    fontFamily: Zv.font,
    scaffoldBackgroundColor: Zv.bg,
    splashFactory: InkSparkle.splashFactory,
  );
  return base.copyWith(
    textTheme: base.textTheme
        .apply(bodyColor: Zv.text, displayColor: Zv.text, fontFamily: Zv.font)
        .copyWith(
          headlineMedium: const TextStyle(
            fontSize: 26,
            fontWeight: FontWeight.w600,
            letterSpacing: -0.5,
            height: 1.15,
            color: Zv.text,
          ),
          titleLarge: const TextStyle(fontSize: 20, fontWeight: FontWeight.w600, color: Zv.text),
          titleMedium: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: Zv.text),
          bodyLarge: const TextStyle(fontSize: 16, color: Zv.text, height: 1.45),
          bodyMedium: const TextStyle(fontSize: 14, color: Zv.text2, height: 1.45),
          labelSmall: const TextStyle(
            fontSize: 11,
            letterSpacing: 1.1,
            fontWeight: FontWeight.w600,
            color: Zv.muted,
          ),
        ),
    appBarTheme: const AppBarTheme(
      backgroundColor: Zv.bg,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      centerTitle: false,
      titleTextStyle: TextStyle(
        fontFamily: Zv.font,
        fontSize: 20,
        fontWeight: FontWeight.w600,
        color: Zv.text,
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: Zv.iris,
        foregroundColor: Colors.white,
        minimumSize: const Size.fromHeight(52),
        textStyle: const TextStyle(fontFamily: Zv.font, fontSize: 16, fontWeight: FontWeight.w600),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Zv.radiusL)),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: Zv.text,
        minimumSize: const Size.fromHeight(52),
        side: const BorderSide(color: Zv.line),
        textStyle: const TextStyle(fontFamily: Zv.font, fontSize: 16, fontWeight: FontWeight.w500),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Zv.radiusL)),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        foregroundColor: Zv.irisText,
        textStyle: const TextStyle(fontFamily: Zv.font, fontSize: 15, fontWeight: FontWeight.w500),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: Zv.sunken,
      hintStyle: const TextStyle(color: Zv.muted),
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(Zv.radiusM),
        borderSide: const BorderSide(color: Zv.line),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(Zv.radiusM),
        borderSide: const BorderSide(color: Zv.line),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(Zv.radiusM),
        borderSide: const BorderSide(color: Zv.iris, width: 1.5),
      ),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: Zv.sunken,
      indicatorColor: Zv.irisRing,
      surfaceTintColor: Colors.transparent,
      height: 68,
      iconTheme: WidgetStateProperty.resolveWith(
        (s) => IconThemeData(
          color: s.contains(WidgetState.selected) ? Zv.irisText : Zv.muted,
          size: 22,
        ),
      ),
      labelTextStyle: WidgetStateProperty.resolveWith(
        (s) => TextStyle(
          fontFamily: Zv.font,
          fontSize: 12,
          fontWeight: FontWeight.w500,
          color: s.contains(WidgetState.selected) ? Zv.text : Zv.muted,
        ),
      ),
    ),
    dividerTheme: const DividerThemeData(color: Zv.lineSoft, thickness: 1, space: 1),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: Zv.raised,
      contentTextStyle: const TextStyle(fontFamily: Zv.font, color: Zv.text, fontSize: 14),
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Zv.radiusM)),
    ),
    chipTheme: ChipThemeData(
      backgroundColor: Zv.surface,
      selectedColor: Zv.irisRing,
      side: const BorderSide(color: Zv.line),
      labelStyle: const TextStyle(fontFamily: Zv.font, fontSize: 13, color: Zv.text),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Zv.radiusS)),
    ),
    progressIndicatorTheme: const ProgressIndicatorThemeData(color: Zv.irisText),
  );
}
