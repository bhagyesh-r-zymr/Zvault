import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'theme.dart';

/// The Zvault mark: a Z on an iris tile.
class BrandMark extends StatelessWidget {
  const BrandMark({super.key, this.size = 40, this.halo = false});

  final double size;
  final bool halo;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: Zv.iris,
        borderRadius: BorderRadius.circular(size * 0.29),
        boxShadow: halo
            ? const [
                BoxShadow(color: Color(0xFF262C4A), spreadRadius: 9),
                BoxShadow(color: Color(0xFF151A33), spreadRadius: 8),
              ]
            : null,
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

const _tileColors = [
  Color(0xFFE9EDF5),
  Color(0xFF635BFF),
  Color(0xFFFF9900),
  Color(0xFF4A154B),
  Color(0xFF1E3B33),
  Color(0xFF3A2A14),
  Color(0xFF33203A),
];

/// A letter tile for an item without an icon. The colour is stable per name.
class LetterTile extends StatelessWidget {
  const LetterTile(this.name, {super.key, this.size = 40});

  final String name;
  final double size;

  @override
  Widget build(BuildContext context) {
    final letter = name.trim().isEmpty ? '?' : name.trim()[0].toUpperCase();
    var hash = 0;
    for (final c in name.codeUnits) {
      hash = (hash * 31 + c) & 0xFFFFFFFF;
    }
    final bg = _tileColors[hash % _tileColors.length];
    final light = bg == _tileColors[0] || bg == _tileColors[2];
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(size * 0.26)),
      child: Text(
        letter,
        style: TextStyle(
          color: light ? Zv.bg : Colors.white,
          fontWeight: FontWeight.w600,
          fontSize: size * 0.42,
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
    final base = Zv.monoStyle.copyWith(fontSize: size, height: 1.4);
    if (masked) {
      return Text(
        '•' * value.length.clamp(12, 24),
        style: base.copyWith(color: Zv.text2, letterSpacing: 1),
        semanticsLabel: 'Hidden',
      );
    }
    final spans = <TextSpan>[];
    final digit = RegExp(r'[0-9]');
    final letter = RegExp(r'[\p{L}\s]', unicode: true);
    for (final ch in value.characters) {
      final color = digit.hasMatch(ch)
          ? Zv.irisText
          : letter.hasMatch(ch)
          ? Zv.text
          : Zv.attn;
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

/// A rounded panel, the Mac app's `.panel`.
class Panel extends StatelessWidget {
  const Panel({super.key, required this.child, this.padding = EdgeInsets.zero});

  final Widget child;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    // Material, not a decorated box, so row ink splashes show.
    return Material(
      color: Zv.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(Zv.radiusL),
        side: const BorderSide(color: Zv.line),
      ),
      clipBehavior: Clip.antiAlias,
      child: Padding(padding: padding, child: child),
    );
  }
}

class SectionLabel extends StatelessWidget {
  const SectionLabel(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 0, 4, 8),
      child: Text(text.toUpperCase(), style: Theme.of(context).textTheme.labelSmall),
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
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: Zv.dangerBg,
        borderRadius: BorderRadius.circular(Zv.radiusM),
        border: Border.all(color: Zv.dangerLine),
      ),
      child: Text(message, style: const TextStyle(color: Zv.danger, fontSize: 14)),
    );
  }
}

/// Parses `#RRGGBB`, or null.
Color? hexColor(String? hex) {
  if (hex == null || !RegExp(r'^#[0-9A-Fa-f]{6}$').hasMatch(hex)) return null;
  return Color(int.parse(hex.substring(1), radix: 16) | 0xFF000000);
}
