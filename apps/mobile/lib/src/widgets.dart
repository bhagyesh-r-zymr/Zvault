import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'theme.dart';

/// The Zvault mark: a Z on an accent tile.
class BrandMark extends StatelessWidget {
  const BrandMark({super.key, this.size = 40, this.halo = false});

  final double size;
  final bool halo;

  @override
  Widget build(BuildContext context) {
    final c = context.zv;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: c.accent,
        borderRadius: BorderRadius.circular(size * 0.29),
        boxShadow: halo ? [BoxShadow(color: c.accentSoft, spreadRadius: 9)] : null,
      ),
      child: CustomPaint(painter: _ZPainter()),
    );
  }
}

class _ZPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final s = size.width * 0.52 / 24;
    final o = Offset(size.width * 0.24, size.height * 0.24);
    final path = Path()
      ..moveTo(o.dx + 5 * s, o.dy + 6 * s)
      ..lineTo(o.dx + 19 * s, o.dy + 6 * s)
      ..lineTo(o.dx + 5 * s, o.dy + 18 * s)
      ..lineTo(o.dx + 19 * s, o.dy + 18 * s);
    canvas.drawPath(
      path,
      Paint()
        ..color = Colors.white
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2.3 * s
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round,
    );
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

/// Brand-like tile colours, all readable under white. Null is the theme's navy.
const _tileColors = <Color?>[
  null,
  Color(0xFF635BFF),
  Color(0xFFF08C00),
  Color(0xFF4A154B),
  Color(0xFFA259FF),
  Color(0xFF336791),
  Color(0xFF2F63D9),
  Color(0xFFE0573F),
  Color(0xFF0F8A6A),
];

/// A letter tile for an item without an icon. The colour is stable per name.
class LetterTile extends StatelessWidget {
  const LetterTile(this.name, {super.key, this.size = 36, this.radius});

  final String name;
  final double size;

  /// Corner radius. Defaults to 8 for list icons and rounder for big ones.
  final double? radius;

  @override
  Widget build(BuildContext context) {
    final letter = name.trim().isEmpty ? '?' : name.trim()[0].toUpperCase();
    var hash = 0;
    for (final c in name.codeUnits) {
      hash = (hash * 31 + c) & 0xFFFFFFFF;
    }
    final bg = _tileColors[hash % _tileColors.length] ?? context.zv.navy;
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(radius ?? (size >= 48 ? size * 0.28 : Zv.radiusS)),
      ),
      child: Text(
        letter,
        style: TextStyle(
          fontFamily: Zv.display,
          color: Colors.white,
          fontWeight: FontWeight.w800,
          fontSize: size * 0.44,
          height: 1,
        ),
      ),
    );
  }
}

/// Colours digits and symbols so a secret can be read aloud without mistakes.
class SecretText extends StatelessWidget {
  const SecretText(this.value, {super.key, this.masked = false, this.size = 16});

  final String value;
  final bool masked;
  final double size;

  @override
  Widget build(BuildContext context) {
    final c = context.zv;
    final base = Zv.monoStyle.copyWith(fontSize: size, height: 1.4, color: c.ink);
    if (masked) {
      return Text(
        '•' * value.length.clamp(12, 24),
        style: base.copyWith(color: c.muted, letterSpacing: 1),
        semanticsLabel: 'Hidden',
      );
    }
    final spans = <TextSpan>[];
    final digit = RegExp(r'[0-9]');
    final letter = RegExp(r'[\p{L}\s]', unicode: true);
    for (final ch in value.characters) {
      final color = digit.hasMatch(ch)
          ? c.digits
          : letter.hasMatch(ch)
          ? c.ink
          : c.symbols;
      spans.add(
        TextSpan(
          text: ch,
          style: TextStyle(color: color),
        ),
      );
    }
    return Text.rich(TextSpan(style: base, children: spans));
  }
}

/// A rounded, bordered card that groups rows. Put dividers between the rows.
class Panel extends StatelessWidget {
  const Panel({super.key, required this.child, this.padding = EdgeInsets.zero});

  final Widget child;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    final c = context.zv;
    // Material, not a decorated box, so row ink splashes show.
    return Material(
      color: c.panel,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(Zv.radiusL),
        side: BorderSide(color: c.line),
      ),
      clipBehavior: Clip.antiAlias,
      child: Padding(padding: padding, child: child),
    );
  }
}

/// A small bold heading above a card.
class SectionLabel extends StatelessWidget {
  const SectionLabel(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(2, 0, 2, 8),
      child: Text(
        text,
        style: TextStyle(
          fontFamily: Zv.display,
          fontSize: 14,
          fontWeight: FontWeight.w700,
          color: context.zv.ink,
        ),
      ),
    );
  }
}

/// A coloured note with an icon: [ZvTone.ok], [ZvTone.attention] or [ZvTone.danger].
enum ZvTone { ok, attention, danger }

class Notice extends StatelessWidget {
  const Notice({super.key, required this.tone, required this.text, this.icon});

  final ZvTone tone;
  final String text;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final c = context.zv;
    final (fg, bg) = switch (tone) {
      ZvTone.ok => (c.ok, c.okSoft),
      ZvTone.attention => (c.attention, c.attentionSoft),
      ZvTone.danger => (c.danger, c.dangerSoft),
    };
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(Zv.radiusM)),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (icon != null) ...[Icon(icon, size: 18, color: fg), const SizedBox(width: 10)],
          Expanded(
            child: Text(text, style: TextStyle(fontSize: 13.5, color: c.ink, height: 1.4)),
          ),
        ],
      ),
    );
  }
}

/// Copies a value and clears the clipboard again after a while, unless
/// something else was copied in between.
class SecureClipboard {
  static Timer? _timer;
  static const clearAfter = Duration(seconds: 60);

  static Future<void> copy(String text) async {
    await Clipboard.setData(ClipboardData(text: text));
    _timer?.cancel();
    _timer = Timer(clearAfter, () async {
      final now = await Clipboard.getData(Clipboard.kTextPlain);
      if (now?.text == text) await Clipboard.setData(const ClipboardData(text: ''));
    });
  }
}

void showToast(BuildContext context, String message) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(message), duration: const Duration(seconds: 2)));
}

/// An inline error line in the danger colours.
class ErrorBanner extends StatelessWidget {
  const ErrorBanner(this.message, {super.key});

  final String message;

  @override
  Widget build(BuildContext context) {
    final c = context.zv;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: c.dangerSoft,
        borderRadius: BorderRadius.circular(Zv.radiusM),
      ),
      child: Text(message, style: TextStyle(color: c.danger, fontSize: 14)),
    );
  }
}

/// Parses `#RRGGBB`, or null.
Color? hexColor(String? hex) {
  if (hex == null || !RegExp(r'^#[0-9A-Fa-f]{6}$').hasMatch(hex)) return null;
  return Color(int.parse(hex.substring(1), radix: 16) | 0xFF000000);
}
