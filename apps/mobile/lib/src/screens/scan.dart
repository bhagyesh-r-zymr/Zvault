import 'dart:io';

import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../theme.dart';
import 'welcome.dart';

/// Full-screen camera that returns the first Zvault sign-in code it sees.
class ScanScreen extends StatefulWidget {
  const ScanScreen({super.key});

  @override
  State<ScanScreen> createState() => _ScanScreenState();
}

class _ScanScreenState extends State<ScanScreen> with SingleTickerProviderStateMixin {
  late final AnimationController _sweep = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1800),
  )..repeat(reverse: true);
  final MobileScannerController? _camera = Platform.isAndroid || Platform.isIOS
      ? MobileScannerController(formats: const [BarcodeFormat.qrCode])
      : null;
  bool _done = false;

  @override
  void dispose() {
    _sweep.dispose();
    _camera?.dispose();
    super.dispose();
  }

  void _found(BarcodeCapture capture) {
    if (_done) return;
    for (final code in capture.barcodes) {
      final value = code.rawValue;
      if (value != null && value.startsWith('zvault://pair?')) {
        _done = true;
        Navigator.of(context).pop(value);
        return;
      }
    }
  }

  Future<void> _paste() async {
    final uri = await askForCode(context);
    if (uri != null && mounted) Navigator.of(context).pop(uri);
  }

  @override
  Widget build(BuildContext context) {
    final camera = _camera;
    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        fit: StackFit.expand,
        children: [
          if (camera != null)
            MobileScanner(controller: camera, onDetect: _found)
          else
            const ColoredBox(color: Color(0xFF07080B)),
          LayoutBuilder(
            builder: (context, box) {
              final side = box.maxWidth * 0.68;
              final top = box.maxHeight * 0.26;
              return Stack(
                children: [
                  CustomPaint(size: box.biggest, painter: _Mask(side, top)),
                  Positioned(
                    left: (box.maxWidth - side) / 2,
                    top: top,
                    width: side,
                    height: side,
                    child: _Viewfinder(sweep: _sweep, empty: camera == null),
                  ),
                  Positioned(
                    left: 24,
                    right: 24,
                    top: top + side + 28,
                    child: Column(
                      children: [
                        Text(
                          'Point at the QR code on your Mac',
                          textAlign: TextAlign.center,
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                        const SizedBox(height: 6),
                        Text(
                          camera == null
                              ? 'This device has no camera. Paste the code instead.'
                              : 'Settings › Devices › Add phone',
                          textAlign: TextAlign.center,
                          style: const TextStyle(color: Zv.text2, fontSize: 14),
                        ),
                      ],
                    ),
                  ),
                ],
              );
            },
          ),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    children: [
                      IconButton(
                        tooltip: 'Close',
                        onPressed: () => Navigator.of(context).pop(),
                        icon: const Icon(Icons.close_rounded, color: Colors.white),
                      ),
                      const Spacer(),
                      if (camera != null)
                        IconButton(
                          tooltip: 'Flashlight',
                          onPressed: camera.toggleTorch,
                          icon: const Icon(Icons.flashlight_on_rounded, color: Colors.white),
                        ),
                    ],
                  ),
                  const Spacer(),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                    child: OutlinedButton(
                      key: const Key('scan-paste'),
                      onPressed: _paste,
                      child: const Text('Paste code instead'),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Mask extends CustomPainter {
  _Mask(this.side, this.top);

  final double side;
  final double top;

  @override
  void paint(Canvas canvas, Size size) {
    final hole = RRect.fromRectAndRadius(
      Rect.fromLTWH((size.width - side) / 2, top, side, side),
      const Radius.circular(28),
    );
    final path = Path()
      ..fillType = PathFillType.evenOdd
      ..addRect(Offset.zero & size)
      ..addRRect(hole);
    canvas.drawPath(path, Paint()..color = const Color(0xB3000000));
  }

  @override
  bool shouldRepaint(covariant _Mask old) => old.side != side || old.top != top;
}

class _Viewfinder extends StatelessWidget {
  const _Viewfinder({required this.sweep, required this.empty});

  final Animation<double> sweep;
  final bool empty;

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        Positioned.fill(child: CustomPaint(painter: _Corners())),
        if (empty)
          const Center(child: Icon(Icons.qr_code_2_rounded, size: 96, color: Color(0x33E9EDF5))),
        AnimatedBuilder(
          animation: sweep,
          builder: (context, _) => Positioned(
            left: 18,
            right: 18,
            top: 18 + (sweep.value * (MediaQuery.of(context).size.width * 0.68 - 38)),
            child: Container(
              height: 2,
              decoration: const BoxDecoration(
                color: Zv.irisText,
                boxShadow: [BoxShadow(color: Zv.iris, blurRadius: 12, spreadRadius: 1)],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _Corners extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()
      ..color = Zv.irisText
      ..strokeWidth = 4
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round;
    const r = 28.0;
    const len = 34.0;
    final w = size.width;
    final h = size.height;
    void corner(double x, double y, double sx, double sy) {
      final path = Path()
        ..moveTo(x, y + sy * (r + len - r))
        ..lineTo(x, y + sy * r)
        ..arcToPoint(
          Offset(x + sx * r, y),
          radius: const Radius.circular(r),
          clockwise: sx * sy > 0,
        )
        ..lineTo(x + sx * (r + len - r), y);
      canvas.drawPath(path, p);
    }

    corner(2, 2, 1, 1);
    corner(w - 2, 2, -1, 1);
    corner(2, h - 2, 1, -1);
    corner(w - 2, h - 2, -1, -1);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
