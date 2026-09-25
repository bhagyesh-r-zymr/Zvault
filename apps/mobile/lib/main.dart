import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'src/app_state.dart';
import 'src/rust/frb_generated.dart';
import 'src/screens/home.dart';
import 'src/screens/lock.dart';
import 'src/screens/quick_unlock.dart';
import 'src/screens/welcome.dart';
import 'src/storage.dart';
import 'src/theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await RustLib.init();
  final state = AppState(store: defaultAccountStore());
  await state.start();
  runApp(ZvaultApp(state: state));
}

class ZvaultApp extends StatefulWidget {
  const ZvaultApp({super.key, required this.state});

  final AppState state;

  @override
  State<ZvaultApp> createState() => _ZvaultAppState();
}

class _ZvaultAppState extends State<ZvaultApp> {
  late final AppLifecycleListener _lifecycle = AppLifecycleListener(
    onHide: widget.state.appHidden,
    onShow: widget.state.appShown,
  );

  @override
  void initState() {
    super.initState();
    _lifecycle;
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ChangeNotifierProvider.value(
      value: widget.state,
      child: MaterialApp(
        title: 'Zvault',
        debugShowCheckedModeBanner: false,
        theme: zvaultTheme(),
        home: const Root(),
      ),
    );
  }
}

/// Picks the screen for the current phase.
class Root extends StatelessWidget {
  const Root({super.key});

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    final Widget screen = switch (app.phase) {
      Phase.loading => const Scaffold(body: Center(child: CircularProgressIndicator())),
      Phase.welcome => const WelcomeScreen(),
      Phase.locked => const LockScreen(),
      Phase.unlocked when app.awaitingQuickUnlockChoice => const QuickUnlockScreen(),
      Phase.unlocked => const HomeScreen(),
    };
    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 250),
      child: KeyedSubtree(key: ValueKey(screen.runtimeType), child: screen),
    );
  }
}
